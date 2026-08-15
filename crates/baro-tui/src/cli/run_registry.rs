//! A live run leaves a record naming the process that owns it, so a run can be
//! listed and stopped from another terminal. Without one the only handle is a
//! command line, and a pattern that does not match it leaves the run alive.

use std::{fs, io, path::PathBuf, time::SystemTime};

use serde::{Deserialize, Serialize};

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
}

pub fn registry_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".baro").join("live"))
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
}

impl Drop for RunHandle {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
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
    };
    let path = dir.join(format!("{}.json", record.id));
    fs::write(&path, serde_json::to_string_pretty(&record).ok()?).ok()?;
    Some(RunHandle { path })
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
}
