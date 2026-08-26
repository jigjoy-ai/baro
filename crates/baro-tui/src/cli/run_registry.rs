//! A live run leaves a record naming the process that owns it, so a run can be
//! listed and stopped from another terminal. Without one the only handle is a
//! command line, and a pattern that does not match it leaves the run alive.

use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};

use crate::events::BaroEvent;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub pid: u32,
    /// The run's own process group, when it leads one: stopping the group
    /// reaches children a pid alone would leave behind.
    #[serde(default)]
    pub process_group: Option<u32>,
    pub cwd: String,
    pub goal: String,
    pub started_at: String,
    /// Where a detached run's stream was redirected. Absent for a run that
    /// writes to the terminal it was launched from, and for records written
    /// before detached runs existed.
    #[serde(default)]
    pub log_path: Option<String>,
}

pub fn registry_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".baro").join("live"))
}

/// Detached runs write here. Created on demand, because the first detached run
/// on a machine is the one that needs the directory.
pub fn logs_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let dir = PathBuf::from(home).join(".baro").join("logs");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The conventional log path for a run id, which `watch`/`logs` can still
/// reach after the registry record has been reaped.
pub fn log_path_for(id: &str) -> Option<PathBuf> {
    Some(logs_dir()?.join(format!("{id}.log")))
}

#[cfg(unix)]
pub fn is_process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
pub fn is_process_alive(_pid: u32) -> bool {
    false
}

#[cfg(unix)]
fn own_process_group() -> Option<u32> {
    let out = std::process::Command::new("ps")
        .args(["-o", "pgid=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(not(unix))]
fn own_process_group() -> Option<u32> {
    None
}

fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("@{secs}")
}

/// Removes its record when the run ends, however it ends.
pub struct RunHandle {
    path: PathBuf,
    /// A detached run outlives the process that registered it, so that process
    /// dropping its handle must not take the record — and the run — with it.
    remove_on_drop: bool,
}

impl Drop for RunHandle {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Registers this process as a live run. A registry that cannot be written is
/// never a reason to refuse the run itself.
pub fn register(goal: &str, cwd: &str) -> Option<RunHandle> {
    let dir = registry_dir()?;
    fs::create_dir_all(&dir).ok()?;
    reap_dead(&dir);

    let pid = std::process::id();
    let record = RunRecord {
        id: format!("run-{pid}"),
        pid,
        process_group: own_process_group(),
        // The listing is read from another terminal, where a relative path
        // names a different directory than the one the run is in.
        cwd: std::fs::canonicalize(cwd)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| cwd.to_string()),
        goal: goal.chars().take(400).collect(),
        started_at: iso_now(),
        log_path: None,
    };
    let path = dir.join(format!("{}.json", record.id));
    fs::write(&path, serde_json::to_string_pretty(&record).ok()?).ok()?;
    Some(RunHandle { path, remove_on_drop: true })
}

/// The record a detached run leaves behind. The id names the child, because
/// the parent prints it and exits, and the group is the child's own: a
/// detached run leads the process tree `baro stop` has to reach.
fn detached_record(goal: &str, cwd: &str, child_pid: u32, log_path: &Path) -> RunRecord {
    RunRecord {
        id: format!("run-{child_pid}"),
        pid: child_pid,
        process_group: Some(child_pid),
        cwd: std::fs::canonicalize(cwd)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| cwd.to_string()),
        goal: goal.chars().take(400).collect(),
        started_at: iso_now(),
        log_path: Some(log_path.display().to_string()),
    }
}

/// Registers a detached child as a live run. The returned handle deliberately
/// does not unregister on drop; the caller is the parent, which exits at once.
// Wired from main.rs's detach path (a sibling story); unreferenced until then.
pub fn register_detached(
    goal: &str,
    cwd: &str,
    child_pid: u32,
    log_path: &Path,
) -> Option<RunHandle> {
    let dir = registry_dir()?;
    fs::create_dir_all(&dir).ok()?;
    reap_dead(&dir);

    let record = detached_record(goal, cwd, child_pid, log_path);
    let path = dir.join(format!("{}.json", record.id));
    fs::write(&path, serde_json::to_string_pretty(&record).ok()?).ok()?;
    Some(RunHandle { path, remove_on_drop: false })
}

fn reap_dead(dir: &PathBuf) {
    for record in read_all(dir) {
        if !is_process_alive(record.1.pid) {
            let _ = fs::remove_file(&record.0);
        }
    }
}

fn read_all(dir: &PathBuf) -> Vec<(PathBuf, RunRecord)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(record) = serde_json::from_str::<RunRecord>(&text) {
                out.push((path, record));
            }
        }
    }
    out.sort_by(|a, b| a.1.started_at.cmp(&b.1.started_at));
    out
}

/// Live runs, with records of dead ones removed first so the list never lies.
pub fn live_runs() -> Vec<RunRecord> {
    let Some(dir) = registry_dir() else {
        return Vec::new();
    };
    reap_dead(&dir);
    read_all(&dir)
        .into_iter()
        .map(|(_, record)| record)
        .filter(|record| is_process_alive(record.pid))
        .collect()
}

pub fn find(id: &str) -> Option<RunRecord> {
    live_runs()
        .into_iter()
        .find(|record| record.id == id || record.pid.to_string() == id)
}

#[cfg(unix)]
fn signal(target: i64, name: &str) {
    let _ = std::process::Command::new("kill")
        .args([&format!("-{name}"), &target.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// A negative target signals the whole process group, which is what reaches
/// the story agents; a pid alone would orphan them.
pub fn signal_target(record: &RunRecord) -> i64 {
    match record.process_group {
        Some(group) => -(group as i64),
        None => record.pid as i64,
    }
}

/// Asks the run's whole tree to stop, then insists.
#[cfg(unix)]
pub fn stop(record: &RunRecord) -> bool {
    let target = signal_target(record);
    signal(target, "TERM");
    for _ in 0..40 {
        if !is_process_alive(record.pid) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    signal(target, "KILL");
    std::thread::sleep(std::time::Duration::from_millis(200));
    !is_process_alive(record.pid)
}

#[cfg(not(unix))]
pub fn stop(_record: &RunRecord) -> bool {
    false
}

pub fn print_runs() {
    let runs = live_runs();
    if runs.is_empty() {
        println!("No baro runs are live.");
        return;
    }
    println!("{:<14}{:<9}{}", "ID", "PID", "GOAL");
    for run in &runs {
        let goal: String = run.goal.chars().take(56).collect();
        println!("{:<14}{:<9}{}", run.id, run.pid, goal.replace('\n', " "));
        println!("{:14}{:9}{}", "", "", run.cwd);
    }
    println!("\nStop one with: baro stop <ID>");
}

pub fn run_stop(args: &[String]) -> Result<(), io::Error> {
    let Some(id) = args.first() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: baro stop <ID>   (list them with: baro runs)",
        ));
    };
    let Some(record) = find(id) else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("No live run {id}. List them with: baro runs"),
        ));
    };
    if stop(&record) {
        println!("Stopped {} ({}).", record.id, record.cwd);
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} did not exit; its process group may already be gone",
            record.id
        )))
    }
}

const FOLLOW_POLL: Duration = Duration::from_millis(200);

enum LogTarget {
    Found(PathBuf),
    /// The registry knows the run, but nothing was written for it.
    NoLog,
    Unknown,
}

/// A run's log is whatever its record points at, falling back to the
/// conventional path so a reaped record is still readable. Separating "no log"
/// from "unknown run" is what lets the caller say which one happened.
fn locate_log(record: Option<&RunRecord>, conventional: Option<PathBuf>) -> LogTarget {
    let candidate = record
        .and_then(|r| r.log_path.as_deref().map(PathBuf::from))
        .or(conventional);
    match candidate {
        Some(path) if path.is_file() => LogTarget::Found(path),
        _ if record.is_some() => LogTarget::NoLog,
        _ => LogTarget::Unknown,
    }
}

/// Reads the file to its end, then keeps reading appended bytes for as long as
/// `follow` holds, so a log can be read while the run is still writing it.
fn tail_file(
    path: &Path,
    follow: &dyn Fn() -> bool,
    sink: &mut dyn FnMut(&[u8]),
) -> io::Result<()> {
    let mut file = fs::File::open(path)?;
    let mut buf = [0u8; 8192];
    loop {
        drain(&mut file, &mut buf, sink)?;
        if !follow() {
            // Bytes that landed between the last read and the check are still
            // part of the run's log.
            drain(&mut file, &mut buf, sink)?;
            return Ok(());
        }
        std::thread::sleep(FOLLOW_POLL);
    }
}

fn drain(
    file: &mut fs::File,
    buf: &mut [u8],
    sink: &mut dyn FnMut(&[u8]),
) -> io::Result<()> {
    loop {
        let read = file.read(buf)?;
        if read == 0 {
            return Ok(());
        }
        sink(&buf[..read]);
    }
}

/// The run id a `watch`/`logs` invocation names, ignoring flags in any order.
fn command_target(args: &[String]) -> Option<&String> {
    args.iter().find(|arg| !arg.starts_with('-'))
}

/// True while the registry still lists the run, which is how `--follow` and
/// `watch` learn that nothing more will be appended.
fn record_still_listed(id: String) -> impl Fn() -> bool {
    move || find(&id).is_some()
}

// Dispatched from main.rs's raw-argv arm (a sibling story); unreferenced here.
pub fn run_logs(args: &[String]) -> i32 {
    let Some(id) = command_target(args) else {
        eprintln!("usage: baro logs <ID> [--follow]   (list them with: baro runs)");
        return 2;
    };
    let follow = args.iter().any(|arg| arg == "--follow");
    let record = find(id);
    let conventional = log_path_for(record.as_ref().map_or(id.as_str(), |r| r.id.as_str()));
    let path = match locate_log(record.as_ref(), conventional) {
        LogTarget::Found(path) => path,
        LogTarget::NoLog => {
            eprintln!("no log for run '{id}'");
            return 2;
        }
        LogTarget::Unknown => {
            eprintln!("unknown run id '{id}'");
            return 2;
        }
    };

    let listed = record_still_listed(id.clone());
    let never: fn() -> bool = || false;
    let follow: &dyn Fn() -> bool = if follow { &listed } else { &never };
    let stdout = io::stdout();
    match stream_log(&path, follow, &mut stdout.lock()) {
        Ok(()) => 0,
        Err(_) => {
            eprintln!("no log for run '{id}'");
            2
        }
    }
}

/// `logs` is a byte pipe, not a parser: a partial trailing line and a line the
/// event schema does not cover both belong in the output verbatim.
fn stream_log(path: &Path, follow: &dyn Fn() -> bool, out: &mut dyn Write) -> io::Result<()> {
    let mut sink = |chunk: &[u8]| {
        let _ = out.write_all(chunk);
        let _ = out.flush();
    };
    tail_file(path, follow, &mut sink)
}

// Dispatched from main.rs's raw-argv arm (a sibling story); unreferenced here.
pub fn run_watch(args: &[String]) -> i32 {
    let Some(id) = command_target(args) else {
        eprintln!("usage: baro watch <ID>   (list them with: baro runs)");
        return 2;
    };
    let record = find(id);
    let conventional = log_path_for(record.as_ref().map_or(id.as_str(), |r| r.id.as_str()));
    let path = match locate_log(record.as_ref(), conventional) {
        LogTarget::Found(path) => path,
        LogTarget::NoLog => {
            eprintln!("no log for run '{id}'");
            return 2;
        }
        LogTarget::Unknown => {
            eprintln!("unknown run id '{id}'");
            return 2;
        }
    };

    let listed = record_still_listed(id.clone());
    let stdout = io::stdout();
    match stream_milestones(&path, &listed, &mut stdout.lock()) {
        Ok(code) => code,
        Err(_) => {
            eprintln!("no log for run '{id}'");
            2
        }
    }
}

/// `watch` reads the same v3 stream the TUI does, keeps only the milestones,
/// and reports the run's own outcome as its exit code.
fn stream_milestones(
    path: &Path,
    follow: &dyn Fn() -> bool,
    out: &mut dyn Write,
) -> io::Result<i32> {
    let mut pending: Vec<u8> = Vec::new();
    let mut terminal: Option<serde_json::Value> = None;
    {
        let mut sink = |chunk: &[u8]| {
            pending.extend_from_slice(chunk);
            while let Some(cut) = pending.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = pending.drain(..=cut).collect();
                report_milestone(&line[..cut], out, &mut terminal);
            }
        };
        tail_file(path, follow, &mut sink)?;
    }
    // A log the run was killed mid-write ends without its final newline; that
    // last line is still a whole event more often than not.
    report_milestone(&pending, out, &mut terminal);
    Ok(watch_exit_code(terminal.as_ref()))
}

fn report_milestone(
    line: &[u8],
    out: &mut dyn Write,
    terminal: &mut Option<serde_json::Value>,
) {
    let Ok(text) = std::str::from_utf8(line) else {
        return;
    };
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let Ok(event) = serde_json::from_str::<BaroEvent>(text) else {
        return;
    };
    if let Some(rendered) = milestone_line(&event) {
        let _ = writeln!(out, "{rendered}");
    }
    if matches!(event, BaroEvent::Done { .. }) {
        *terminal = serde_json::from_str(text).ok();
    }
}

fn one_line(text: &str, limit: usize) -> String {
    text.replace('\n', " ").chars().take(limit).collect()
}

/// The milestone subset `watch` prints (docs/tui-protocol-v3.md §5), rendered
/// for a human reading a terminal rather than for a parser.
fn milestone_line(event: &BaroEvent) -> Option<String> {
    let line = match event {
        BaroEvent::StoryStart { id, title } => {
            format!("story_start   {id}  {}", one_line(title, 120))
        }
        BaroEvent::Critique {
            id,
            verdict,
            reasoning,
            ..
        } => {
            let verdict = if verdict.is_empty() { "?" } else { verdict };
            match reasoning.trim() {
                "" => format!("critique      {id}  {verdict}"),
                why => format!("critique      {id}  {verdict} — {}", one_line(why, 160)),
            }
        }
        BaroEvent::StoryMerged { id, mode } => {
            format!("story_merged  {id}  ({mode})")
        }
        BaroEvent::MergeFailed { id, error } => {
            format!("merge_failed  {id}  {}", one_line(error, 160))
        }
        BaroEvent::Done {
            total_time_secs,
            stats,
            success,
            abort_reason,
            ..
        } => {
            let outcome = if *success { "success" } else { "failed" };
            let mut line = format!(
                "done          {outcome} in {total_time_secs}s — {} stories, {} commits",
                stats.stories_completed, stats.total_commits
            );
            if let Some(reason) = abort_reason.as_deref().filter(|r| !r.is_empty()) {
                line.push_str(&format!(" ({})", one_line(reason, 160)));
            }
            line
        }
        _ => return None,
    };
    Some(line)
}

/// The run's terminal event decides the exit code. An absent `success` is a
/// success, because that is what the v3 `done` schema means by omitting it.
pub fn watch_exit_code(terminal: Option<&serde_json::Value>) -> i32 {
    let Some(event) = terminal else {
        return 1;
    };
    if let Some(success) = event.get("success").and_then(|v| v.as_bool()) {
        return i32::from(!success);
    }
    for key in ["status", "result"] {
        if let Some(text) = event.get(key).and_then(|v| v.as_str()) {
            return i32::from(text != "success");
        }
    }
    0
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    // Tests in one binary run in parallel: a shared directory would make them
    // observe each other's records.
    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("baro-registry-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_record(dir: &PathBuf, id: &str, pid: u32) {
        fs::create_dir_all(dir).unwrap();
        let record = RunRecord {
            id: id.to_string(),
            pid,
            process_group: None,
            cwd: "/tmp/project".into(),
            goal: "ship the thing".into(),
            started_at: "@1".into(),
            log_path: None,
        };
        fs::write(
            dir.join(format!("{id}.json")),
            serde_json::to_string(&record).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn a_record_whose_process_is_gone_is_not_reported_as_live() {
        let home = temp_home("reap");
        let live = home.join(".baro").join("live");
        // A pid this large cannot be running: it is above the platform maximum.
        write_record(&live, "run-dead", 4_294_967_290);
        write_record(&live, "run-alive", std::process::id());

        let dir = live.clone();
        reap_dead(&dir);
        let remaining: Vec<String> = read_all(&dir)
            .into_iter()
            .map(|(_, record)| record.id)
            .collect();

        assert_eq!(remaining, vec!["run-alive".to_string()]);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn stopping_reaches_the_group_when_the_run_leads_one() {
        let leader = RunRecord {
            id: "run-1".into(),
            pid: 1234,
            process_group: Some(999),
            cwd: "/tmp".into(),
            goal: "g".into(),
            started_at: "@1".into(),
            log_path: None,
        };
        assert_eq!(signal_target(&leader), -999);

        let orphan = RunRecord { process_group: None, ..leader };
        assert_eq!(signal_target(&orphan), 1234);
    }

    #[test]
    fn a_record_the_registry_cannot_parse_never_appears_as_a_run() {
        let home = temp_home("parse");
        let live = home.join(".baro").join("live");
        fs::create_dir_all(&live).unwrap();
        write_record(&live, "run-good", std::process::id());
        fs::write(live.join("run-broken.json"), "{ not json").unwrap();
        fs::write(live.join("notes.txt"), "ignored").unwrap();

        let found: Vec<String> = read_all(&live)
            .into_iter()
            .map(|(_, record)| record.id)
            .collect();

        assert_eq!(found, vec!["run-good".to_string()]);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_detached_runs_log_path_survives_the_registry_and_older_records_do_not_grow_one() {
        let record = detached_record(
            "ship it",
            "/tmp",
            4242,
            Path::new("/home/dev/.baro/logs/run-4242.log"),
        );
        assert_eq!(record.id, "run-4242");
        assert_eq!(record.pid, 4242);
        // A detached child leads its own group, so `baro stop` reaches its tree.
        assert_eq!(record.process_group, Some(4242));

        let json = serde_json::to_string(&record).unwrap();
        let parsed: RunRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed.log_path.as_deref(),
            Some("/home/dev/.baro/logs/run-4242.log")
        );

        let legacy = r#"{"id":"run-7","pid":7,"cwd":"/tmp","goal":"g","started_at":"@1"}"#;
        let parsed: RunRecord = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.log_path, None);
    }

    #[test]
    fn a_detached_handle_leaves_its_record_behind_while_an_attached_one_removes_it() {
        let home = temp_home("handles");
        let attached = home.join("attached.json");
        let detached = home.join("detached.json");
        fs::write(&attached, "{}").unwrap();
        fs::write(&detached, "{}").unwrap();

        drop(RunHandle { path: attached.clone(), remove_on_drop: true });
        drop(RunHandle { path: detached.clone(), remove_on_drop: false });

        assert!(!attached.exists());
        assert!(detached.exists());
        let _ = fs::remove_dir_all(&home);
    }

    fn live_record(id: &str, log_path: Option<&str>) -> RunRecord {
        RunRecord {
            id: id.to_string(),
            pid: std::process::id(),
            process_group: None,
            cwd: "/tmp".into(),
            goal: "g".into(),
            started_at: "@1".into(),
            log_path: log_path.map(str::to_string),
        }
    }

    #[test]
    fn a_log_is_resolved_from_the_record_then_the_convention_then_reported_missing() {
        let home = temp_home("locate");
        let written = home.join("run-1.log");
        fs::write(&written, "x").unwrap();
        let absent = home.join("run-9.log");

        let record = live_record("run-1", Some(written.to_str().unwrap()));
        assert!(matches!(
            locate_log(Some(&record), None),
            LogTarget::Found(path) if path == written
        ));

        // Reaped record: only the conventional path is left to try.
        assert!(matches!(
            locate_log(None, Some(written.clone())),
            LogTarget::Found(path) if path == written
        ));

        // A live run that has not written anything is not an unknown run.
        let record = live_record("run-9", None);
        assert!(matches!(
            locate_log(Some(&record), Some(absent.clone())),
            LogTarget::NoLog
        ));
        assert!(matches!(locate_log(None, Some(absent)), LogTarget::Unknown));
        assert!(matches!(locate_log(None, None), LogTarget::Unknown));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn logs_prints_the_file_verbatim_including_a_partial_last_line() {
        let home = temp_home("logs-verbatim");
        let log = home.join("run-1.log");
        fs::write(&log, "{\"type\":\"story_log\"}\nnot json at all\ntrailing").unwrap();

        let mut out: Vec<u8> = Vec::new();
        stream_log(&log, &|| false, &mut out).unwrap();

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "{\"type\":\"story_log\"}\nnot json at all\ntrailing"
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn logs_reports_a_file_that_is_not_there() {
        let home = temp_home("logs-missing");
        let mut out: Vec<u8> = Vec::new();
        let result = stream_log(&home.join("gone.log"), &|| false, &mut out);
        assert!(result.is_err());
        assert!(out.is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn following_picks_up_bytes_appended_after_the_first_read_and_stops_when_the_record_goes() {
        use std::cell::Cell;

        let home = temp_home("logs-follow");
        let log = home.join("run-1.log");
        fs::write(&log, "first\n").unwrap();

        // The poll itself appends, so the tail is proven to re-read rather
        // than to have raced the writer.
        let polls = Cell::new(0);
        let follow = || {
            let poll = polls.get() + 1;
            polls.set(poll);
            if poll == 1 {
                let mut file = fs::OpenOptions::new().append(true).open(&log).unwrap();
                file.write_all(b"second\n").unwrap();
                return true;
            }
            false
        };

        let mut out: Vec<u8> = Vec::new();
        stream_log(&log, &follow, &mut out).unwrap();

        assert_eq!(String::from_utf8(out).unwrap(), "first\nsecond\n");
        assert_eq!(polls.get(), 2);
        let _ = fs::remove_dir_all(&home);
    }

    fn synthetic_log(terminal: Option<&str>) -> String {
        let mut lines = vec![
            r#"{"type":"init","project":"baro","stories":[]}"#.to_string(),
            r#"{"type":"story_start","id":"S2","title":"Run registry"}"#.to_string(),
            r#"{"type":"story_log","id":"S2","line":"noise"}"#.to_string(),
            r#"{"type":"activity","id":"S2","kind":"tool","text":"noise"}"#.to_string(),
            "{ not json".to_string(),
            r#"{"type":"critique","id":"S2","verdict":"pass","reasoning":"covers the\ncriteria"}"#
                .to_string(),
            r#"{"type":"story_merged","id":"S2","mode":"worktree"}"#.to_string(),
            r#"{"type":"merge_failed","id":"S3","error":"conflict"}"#.to_string(),
        ];
        if let Some(terminal) = terminal {
            lines.push(terminal.to_string());
        }
        format!("{}\n", lines.join("\n"))
    }

    fn done_line(success: bool) -> String {
        format!(
            r#"{{"type":"done","total_time_secs":42,"success":{success},"stats":{{"stories_completed":7,"stories_skipped":0,"total_commits":7,"files_created":1,"files_modified":2}}}}"#
        )
    }

    fn watch_over(log_text: &str, name: &str) -> (String, i32) {
        let home = temp_home(name);
        let log = home.join("run-1.log");
        fs::write(&log, log_text).unwrap();
        let mut out: Vec<u8> = Vec::new();
        let code = stream_milestones(&log, &|| false, &mut out).unwrap();
        let _ = fs::remove_dir_all(&home);
        (String::from_utf8(out).unwrap(), code)
    }

    #[test]
    fn watch_prints_only_milestones_and_exits_on_the_runs_own_outcome() {
        let (printed, code) = watch_over(&synthetic_log(Some(&done_line(true))), "watch-ok");

        assert_eq!(
            printed.lines().collect::<Vec<_>>(),
            vec![
                "story_start   S2  Run registry",
                "critique      S2  pass — covers the criteria",
                "story_merged  S2  (worktree)",
                "merge_failed  S3  conflict",
                "done          success in 42s — 7 stories, 7 commits",
            ]
        );
        assert_eq!(code, 0);
    }

    #[test]
    fn watch_fails_on_a_failed_run_and_on_a_log_that_never_reached_its_end() {
        let (printed, code) = watch_over(&synthetic_log(Some(&done_line(false))), "watch-fail");
        assert!(printed.ends_with("done          failed in 42s — 7 stories, 7 commits\n"));
        assert_eq!(code, 1);

        // Truncated: the run was killed before it could report an outcome.
        let (printed, code) = watch_over(&synthetic_log(None), "watch-truncated");
        assert!(!printed.contains("done"));
        assert_eq!(code, 1);
    }

    #[test]
    fn watch_reads_a_final_line_that_never_got_its_newline() {
        let (printed, code) = watch_over(&done_line(true), "watch-unterminated");
        assert_eq!(printed, "done          success in 42s — 7 stories, 7 commits\n");
        assert_eq!(code, 0);
    }

    #[test]
    fn the_exit_code_follows_whatever_the_terminal_event_reports() {
        let value = |json: &str| serde_json::from_str::<serde_json::Value>(json).unwrap();

        assert_eq!(watch_exit_code(None), 1);
        assert_eq!(watch_exit_code(Some(&value(r#"{"success":true}"#))), 0);
        assert_eq!(watch_exit_code(Some(&value(r#"{"success":false}"#))), 1);
        assert_eq!(watch_exit_code(Some(&value(r#"{"status":"success"}"#))), 0);
        assert_eq!(watch_exit_code(Some(&value(r#"{"status":"aborted"}"#))), 1);
        assert_eq!(watch_exit_code(Some(&value(r#"{"result":"success"}"#))), 0);
        assert_eq!(watch_exit_code(Some(&value(r#"{"result":"failed"}"#))), 1);
        // Older orchestrators omit `success`, and the v3 schema reads that
        // omission as a successful run.
        assert_eq!(watch_exit_code(Some(&value(r#"{"type":"done"}"#))), 0);
    }

    #[test]
    fn a_flag_before_the_run_id_does_not_become_the_run_id() {
        let args = ["--follow".to_string(), "run-1".to_string()];
        assert_eq!(command_target(&args).unwrap(), "run-1");
        let args = ["run-1".to_string(), "--follow".to_string()];
        assert_eq!(command_target(&args).unwrap(), "run-1");
        assert_eq!(command_target(&["--follow".to_string()]), None);
        assert_eq!(command_target(&[]), None);
    }
}
