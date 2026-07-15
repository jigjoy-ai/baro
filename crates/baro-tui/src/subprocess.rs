//! Spawn external commands, capture stdout + stderr, persist a
//! timestamped log to `~/.baro/runs/<tag>-<unix_secs>.log`, and turn
//! a non-zero exit into a structured error carrying the log path.
//! Deliberately generic: the caller passes a fully-built `Command`
//! and a tag for the log filename.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

/// Captured output of a successful subprocess run. stderr and the log
/// path aren't fields — no caller reads them on the success path; the log
/// path only matters when a run FAILS, where it rides on `ProcessRunError`.
#[derive(Debug)]
pub struct CapturedOutput {
    pub stdout: String,
}

/// Subprocess failure — non-zero exit or spawn error. Callers
/// downcast to this type to extract `log_path`.
#[derive(Debug)]
pub struct ProcessRunError {
    pub message: String,
    pub log_path: Option<PathBuf>,
}

impl std::fmt::Display for ProcessRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ProcessRunError {}

/// Captures stdout while streaming stderr line-by-line to `on_line`
/// while the run is still in flight — the planner/architect phases use this
/// to surface `@baro-progress` lines during the otherwise-silent wait.
/// stdout is drained on a concurrent task and returned byte-identical to
/// the PRD/decision-doc result; a chatty stderr
/// can't deadlock the pipe.
pub async fn spawn_and_capture_streaming(
    mut cmd: Command,
    log_tag: &str,
    on_line: impl Fn(&str),
) -> Result<CapturedOutput, ProcessRunError> {
    // Any caller-side timeout/cancellation that drops this future must also
    // terminate the child. Otherwise a detached provider process can keep
    // running after the authoritative Baro phase has failed.
    cmd.kill_on_drop(true);
    configure_process_tree(&mut cmd);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| ProcessRunError {
        message: format!("failed to spawn {}: {}", log_tag, e),
        log_path: None,
    })?;
    let mut process_tree = ProcessTreeGuard::new(child.id());

    let stdout_pipe = child.stdout.take().expect("stdout piped above");
    let stderr_pipe = child.stderr.take().expect("stderr piped above");

    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut rdr = stdout_pipe;
        let _ = rdr.read_to_end(&mut buf).await;
        buf
    });

    let mut stderr_acc = String::new();
    let mut lines = BufReader::new(stderr_pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        on_line(&line);
        stderr_acc.push_str(&line);
        stderr_acc.push('\n');
    }

    let status = child.wait().await.map_err(|e| ProcessRunError {
        message: format!("{} process error: {}", log_tag, e),
        log_path: None,
    })?;
    process_tree.disarm();

    let stdout_bytes = stdout_task.await.unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let log_path = persist_log(log_tag, &stdout, &stderr_acc);

    if !status.success() {
        let code = status.code();
        return Err(ProcessRunError {
            message: format!(
                "{} exited with code {}{}",
                log_tag,
                code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                detail_tail(&stdout, &stderr_acc),
            ),
            log_path,
        });
    }

    Ok(CapturedOutput { stdout })
}

/// Spawn `cmd` and stream its STDOUT line-by-line to `on_event` — the
/// planner/architect emit their live BaroEvent JSON there while the RESULT
/// (PRD / decision doc) goes to a `--result-file` the caller reads afterward.
/// STDERR (debug logs) is drained on a concurrent task, kept out of the event
/// stream, and persisted to the log alongside the events. Non-zero exit →
/// ProcessRunError with the stderr tail; the log path survives either way.
pub async fn spawn_and_stream_events(
    mut cmd: Command,
    log_tag: &str,
    on_event: impl Fn(&str),
) -> Result<Option<PathBuf>, ProcessRunError> {
    cmd.kill_on_drop(true);
    configure_process_tree(&mut cmd);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| ProcessRunError {
        message: format!("failed to spawn {}: {}", log_tag, e),
        log_path: None,
    })?;
    let mut process_tree = ProcessTreeGuard::new(child.id());

    let stdout_pipe = child.stdout.take().expect("stdout piped above");
    let stderr_pipe = child.stderr.take().expect("stderr piped above");

    // Drain stderr concurrently so a chatty debug log can't wedge the pipe
    // while we're parked reading the event stream.
    let stderr_task = tokio::spawn(async move {
        let mut acc = String::new();
        let mut lines = BufReader::new(stderr_pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            acc.push_str(&line);
            acc.push('\n');
        }
        acc
    });

    let mut stdout_acc = String::new();
    let mut lines = BufReader::new(stdout_pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        on_event(trimmed);
        stdout_acc.push_str(&line);
        stdout_acc.push('\n');
    }

    let status = child.wait().await.map_err(|e| ProcessRunError {
        message: format!("{} process error: {}", log_tag, e),
        log_path: None,
    })?;
    process_tree.disarm();

    let stderr_acc = stderr_task.await.unwrap_or_default();
    let log_path = persist_log(log_tag, &stdout_acc, &stderr_acc);

    if !status.success() {
        let code = status.code();
        return Err(ProcessRunError {
            message: format!(
                "{} exited with code {}{}",
                log_tag,
                code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                detail_tail(&stdout_acc, &stderr_acc),
            ),
            log_path,
        });
    }

    Ok(log_path)
}

/// Put each supervised command at the root of its own process group. On Unix,
/// descendants inherit that group, so cancelling the Rust future can terminate
/// Node and any provider CLI it has already spawned as one unit. `kill_on_drop`
/// remains enabled as a direct-child fallback.
pub(crate) fn configure_process_tree(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
}

/// Cancellation guard for the complete process tree rooted at a supervised
/// child. A normal `wait()` disarms it; dropping the future first does not.
pub(crate) struct ProcessTreeGuard {
    pid: Option<u32>,
}

impl ProcessTreeGuard {
    pub(crate) fn new(pid: Option<u32>) -> Self {
        Self { pid }
    }

    pub(crate) fn disarm(&mut self) {
        self.pid = None;
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        let Some(pid) = self.pid.take() else {
            return;
        };

        #[cfg(unix)]
        {
            // SAFETY: POSIX `kill` accepts a negative pid to address a process
            // group. The child was made leader of group `pid` before spawn.
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            const SIGKILL: i32 = 9;
            if let Ok(group) = i32::try_from(pid) {
                // Ignore ESRCH: the process tree may already have exited while
                // cancellation was propagating.
                let _ = unsafe { kill(-group, SIGKILL) };
            }
        }

        #[cfg(windows)]
        {
            // `Child::kill_on_drop` only terminates the direct process on
            // Windows. `taskkill /T` is the platform-provided tree equivalent;
            // run it synchronously so the root cannot disappear before its
            // descendants are discovered.
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}

/// Append the tail of stderr (or stdout fallback) to the exit message.
/// The "empty output" case is called out explicitly — that's the
/// failure mode where stock error messages tell the user nothing.
fn detail_tail(stdout: &str, stderr: &str) -> String {
    let stderr_trim = stderr.trim();
    let stdout_trim = stdout.trim();
    if !stderr_trim.is_empty() {
        format!(": {}", stderr_trim)
    } else if !stdout_trim.is_empty() {
        format!(": (no stderr) stdout: {}", stdout_trim)
    } else {
        " with empty output".to_string()
    }
}

/// Write `~/.baro/runs/<tag>-<unix_secs>.log` containing both streams.
/// `None` on any failure — we'd rather lose the log than crash the run.
fn persist_log(tag: &str, stdout: &str, stderr: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let dir = home.join(".baro").join("runs");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let unix_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("{}-{}.log", tag, unix_secs));
    let body = format!("=== STDOUT ===\n{}\n\n=== STDERR ===\n{}\n", stdout, stderr,);
    if std::fs::write(&path, body).is_err() {
        return None;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[tokio::test]
    async fn streaming_captures_stdout_intact_and_sees_stderr_lines() {
        // stdout interleaved with stderr — stdout must come back byte-exact,
        // and on_line must observe every stderr line.
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(
            "printf 'RESULT-LINE-1\\nRESULT-LINE-2'; \
             printf 'err-a\\nerr-b\\n' >&2",
        );

        let seen = Mutex::new(Vec::<String>::new());
        let out = spawn_and_capture_streaming(cmd, "test", |l| {
            seen.lock().unwrap().push(l.to_string());
        })
        .await
        .expect("command should succeed");

        assert_eq!(out.stdout, "RESULT-LINE-1\nRESULT-LINE-2");
        assert_eq!(*seen.lock().unwrap(), vec!["err-a", "err-b"]);
    }

    #[tokio::test]
    async fn streaming_nonzero_exit_is_error_with_detail() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("printf 'boom' >&2; exit 7");
        let err = spawn_and_capture_streaming(cmd, "test", |_| {})
            .await
            .expect_err("non-zero exit must be an error");
        assert!(err.message.contains("code 7"), "got: {}", err.message);
        assert!(err.message.contains("boom"), "got: {}", err.message);
    }

    #[tokio::test]
    async fn stream_events_forwards_stdout_lines_not_stderr() {
        // Only stdout lines (the event stream) reach on_event; stderr stays
        // out of it. Empty lines are skipped.
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("printf 'EV-1\\n\\nEV-2\\n'; printf 'debug-noise\\n' >&2");
        let seen = Mutex::new(Vec::<String>::new());
        spawn_and_stream_events(cmd, "test", |l| {
            seen.lock().unwrap().push(l.to_string());
        })
        .await
        .expect("command should succeed");
        assert_eq!(*seen.lock().unwrap(), vec!["EV-1", "EV-2"]);
    }

    #[tokio::test]
    async fn stream_events_nonzero_exit_is_error_with_detail() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("printf 'kaboom' >&2; exit 5");
        let err = spawn_and_stream_events(cmd, "test", |_| {})
            .await
            .expect_err("non-zero exit must be an error");
        assert!(err.message.contains("code 5"), "got: {}", err.message);
        assert!(err.message.contains("kaboom"), "got: {}", err.message);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_stream_supervision_kills_the_process_tree_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let started = directory.path().join("started");
        let escaped = directory.path().join("escaped");
        let descendant_pid = directory.path().join("descendant-pid");
        let mut cmd = Command::new("sh");
        cmd.env("BARO_TEST_STARTED", &started)
            .env("BARO_TEST_ESCAPED", &escaped)
            .env("BARO_TEST_DESCENDANT_PID", &descendant_pid)
            .arg("-c")
            .arg(
                "(trap '' TERM; sleep 10; touch \"$BARO_TEST_ESCAPED\") & \
                 echo \"$!\" > \"$BARO_TEST_DESCENDANT_PID\"; \
                 touch \"$BARO_TEST_STARTED\"; wait",
            );

        let task =
            tokio::spawn(
                async move { spawn_and_stream_events(cmd, "kill-on-drop-test", |_| {}).await },
            );
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        while !started.exists() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(started.exists(), "fixture child never started");
        let descendant_pid = std::fs::read_to_string(&descendant_pid)
            .unwrap()
            .trim()
            .to_string();

        task.abort();
        let _ = task.await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while unix_process_exists(&descendant_pid) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            !unix_process_exists(&descendant_pid),
            "a descendant remained alive after its supervisor was dropped"
        );
        assert!(
            !escaped.exists(),
            "a descendant escaped after its supervisor was dropped"
        );
    }

    #[cfg(unix)]
    fn unix_process_exists(pid: &str) -> bool {
        std::process::Command::new("kill")
            .args(["-0", pid])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}
