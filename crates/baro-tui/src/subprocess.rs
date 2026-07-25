//! Spawn external commands, capture stdout + stderr, persist a
//! timestamped log to `~/.baro/runs/<tag>-<unix_secs>.log`, and turn
//! a non-zero exit into a structured error carrying the log path.
//! Deliberately generic: the caller passes a fully-built `Command`
//! and a tag for the log filename.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

#[cfg(windows)]
mod windows_job;

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
    let mut process_tree = ProcessTreeGuard::attach(&mut child).map_err(|e| ProcessRunError {
        message: format!("failed to supervise {} process tree: {}", log_tag, e),
        log_path: None,
    })?;

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
    let mut stderr_open = true;
    let mut status = None;
    let mut wait = Box::pin(child.wait());
    while status.is_none() || stderr_open {
        tokio::select! {
            wait_result = &mut wait, if status.is_none() => {
                let observed = wait_result.map_err(|e| ProcessRunError {
                    message: format!("{} process error: {}", log_tag, e),
                    log_path: None,
                })?;
                // A completed supervised phase must not leave provider
                // descendants behind, even on exit 0. Terminate the residual
                // group before waiting for inherited pipes to reach EOF.
                process_tree.terminate();
                status = Some(observed);
            }
            line_result = lines.next_line(), if stderr_open => {
                match line_result {
                    Ok(Some(line)) => {
                        on_line(&line);
                        stderr_acc.push_str(&line);
                        stderr_acc.push('\n');
                    }
                    Ok(None) | Err(_) => stderr_open = false,
                }
            }
        }
    }
    let status = status.expect("child wait branch must complete");

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
/// STDERR (debug logs) is drained concurrently, kept out of the event stream,
/// and persisted to the log alongside the events. Non-zero exit →
/// ProcessRunError with the stderr tail; the log path survives either way.
pub async fn spawn_and_stream_events(
    cmd: Command,
    log_tag: &str,
    on_event: impl Fn(&str),
) -> Result<Option<PathBuf>, ProcessRunError> {
    spawn_and_stream_events_with_stderr(cmd, log_tag, on_event, |_| {}).await
}

/// Variant of [`spawn_and_stream_events`] that exposes each stderr line while
/// the child is still running. Callers must filter/redact before forwarding;
/// stderr is untrusted diagnostic data and never enters the JSON event lane.
pub async fn spawn_and_stream_events_with_stderr(
    mut cmd: Command,
    log_tag: &str,
    on_event: impl Fn(&str),
    on_stderr: impl Fn(&str),
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
    let mut process_tree = ProcessTreeGuard::attach(&mut child).map_err(|e| ProcessRunError {
        message: format!("failed to supervise {} process tree: {}", log_tag, e),
        log_path: None,
    })?;

    let stdout_pipe = child.stdout.take().expect("stdout piped above");
    let stderr_pipe = child.stderr.take().expect("stderr piped above");

    let mut stdout_acc = String::new();
    let mut stderr_acc = String::new();
    let mut stdout_lines = BufReader::new(stdout_pipe).lines();
    let mut stderr_lines = BufReader::new(stderr_pipe).lines();
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut status = None;
    let mut wait = Box::pin(child.wait());
    while status.is_none() || stdout_open || stderr_open {
        tokio::select! {
            wait_result = &mut wait, if status.is_none() => {
                let observed = wait_result.map_err(|e| ProcessRunError {
                    message: format!("{} process error: {}", log_tag, e),
                    log_path: None,
                })?;
                // Exit status describes only the direct root. Always clean its
                // residual provider group before waiting for stdout EOF.
                process_tree.terminate();
                status = Some(observed);
            }
            line_result = stdout_lines.next_line(), if stdout_open => {
                match line_result {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            on_event(trimmed);
                            stdout_acc.push_str(&line);
                            stdout_acc.push('\n');
                        }
                    }
                    Ok(None) | Err(_) => stdout_open = false,
                }
            }
            line_result = stderr_lines.next_line(), if stderr_open => {
                match line_result {
                    Ok(Some(line)) => {
                        on_stderr(&line);
                        stderr_acc.push_str(&line);
                        stderr_acc.push('\n');
                    }
                    Ok(None) | Err(_) => stderr_open = false,
                }
            }
        }
    }
    let status = status.expect("child wait branch must complete");

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

/// Configure the platform containment primitive before spawn. Unix descendants
/// inherit a dedicated process group. Windows starts the root suspended so it
/// can be assigned to a kill-on-close Job Object before any provider code runs.
/// `kill_on_drop` remains enabled as a direct-child fallback.
pub(crate) fn configure_process_tree(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }

    #[cfg(windows)]
    windows_job::configure(cmd);
}

/// Cancellation guard for the contained process tree rooted at a supervised
/// child. Completion and cancellation terminate remaining group/job members;
/// the containment handle survives direct-root exit.
pub(crate) struct ProcessTreeGuard {
    #[cfg(not(windows))]
    pid: Option<u32>,
    #[cfg(windows)]
    job: Option<windows_job::WindowsJob>,
}

impl ProcessTreeGuard {
    pub(crate) fn attach(child: &mut tokio::process::Child) -> std::io::Result<Self> {
        #[cfg(windows)]
        {
            let job = windows_job::WindowsJob::attach_and_resume(child)?;
            Ok(Self { job: Some(job) })
        }

        #[cfg(not(windows))]
        {
            Ok(Self { pid: child.id() })
        }
    }

    pub(crate) fn terminate(&mut self) {
        #[cfg(not(windows))]
        if let Some(pid) = self.pid.take() {
            terminate_process_tree(pid);
        }

        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            job.terminate();
        }
    }

    /// Ask a live root to run its own shutdown handlers without surrendering
    /// the hard-cleanup handle. Detached groups are owned through the private
    /// Node-to-Rust manifest rather than inferred from a process-table walk.
    pub(crate) fn request_graceful_shutdown(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            signal_process_group(pid, SIGTERM);
        }

        #[cfg(not(unix))]
        self.terminate();
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        #[cfg(not(windows))]
        {
            let Some(pid) = self.pid.take() else {
                return;
            };

            terminate_process_tree(pid);
        }

        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            job.terminate();
        }
    }
}

#[cfg(not(windows))]
fn terminate_process_tree(pid: u32) {
    #[cfg(unix)]
    signal_process_group(pid, SIGKILL);
}

#[cfg(unix)]
const SIGKILL: i32 = 9;
#[cfg(unix)]
const SIGTERM: i32 = 15;

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: i32) {
    // SAFETY: POSIX `kill` accepts a negative pid to address a process group.
    // The child was made leader of group `pid` before spawn.
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if let Ok(group) = i32::try_from(pid) {
        // Ignore ESRCH: shutdown may have won the race before signal delivery.
        let _ = unsafe { kill(-group, signal) };
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
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
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
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use tokio::sync::Notify;

    #[cfg(unix)]
    static PROCESS_TREE_TEST_LOCK: Mutex<()> = Mutex::new(());

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
    async fn stream_events_exposes_selected_stderr_before_child_exit() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("printf 'live-diagnostic\\n' >&2; sleep 1");
        let observed = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        let callback_observed = Arc::clone(&observed);
        let callback_notify = Arc::clone(&notify);

        let task = tokio::spawn(async move {
            spawn_and_stream_events_with_stderr(
                cmd,
                "test",
                |_| {},
                move |line| {
                    if line == "live-diagnostic" {
                        callback_observed.store(true, Ordering::SeqCst);
                        callback_notify.notify_one();
                    }
                },
            )
            .await
        });

        tokio::time::timeout(std::time::Duration::from_millis(500), notify.notified())
            .await
            .expect("stderr callback was not invoked while the child was live");
        assert!(observed.load(Ordering::SeqCst));
        assert!(
            !task.is_finished(),
            "stderr callback arrived only after child completion"
        );
        task.await
            .expect("supervision task panicked")
            .expect("fixture should exit successfully");
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

    #[cfg(windows)]
    #[tokio::test]
    async fn successful_root_reap_still_terminates_windows_job_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let descendant_pid = directory.path().join("descendant-pid");
        let root_script = directory.path().join("root.ps1");
        let escaped_pid_path = descendant_pid.to_string_lossy().replace('\'', "''");
        std::fs::write(
            &root_script,
            format!(
                r#"$child = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "Start-Sleep -Seconds 60") `
    -PassThru -NoNewWindow
[System.IO.File]::WriteAllText('{escaped_pid_path}', [string]$child.Id)
Write-Output '{{"fixture":"root-exiting"}}'
exit 0
"#,
            ),
        )
        .unwrap();

        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&root_script);

        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            spawn_and_stream_events(cmd, "windows-job-root-reap", |_| {}),
        )
        .await
        .expect("post-reap Job termination must close inherited pipes")
        .expect("root fixture should exit successfully");

        let pid: u32 = std::fs::read_to_string(&descendant_pid)
            .expect("root fixture did not record its descendant")
            .trim()
            .parse()
            .unwrap();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while windows_process_exists(pid) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            !windows_process_exists(pid),
            "a descendant remained alive after its direct root was reaped"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn nonzero_exit_terminates_inherited_pipe_descendants() {
        let _serial = PROCESS_TREE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = tempfile::tempdir().unwrap();
        let descendant_pid = directory.path().join("descendant-pid");
        let mut cmd = Command::new("sh");
        cmd.env("BARO_TEST_DESCENDANT_PID", &descendant_pid)
            .arg("-c")
            .arg(
                "(trap '' TERM; sleep 10) \
                 & \
                 echo \"$!\" > \"$BARO_TEST_DESCENDANT_PID\"; exit 7",
            );

        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            spawn_and_stream_events(cmd, "nonzero-tree-test", |_| {}),
        )
        .await
        .expect("nonzero root must be observed before inherited pipe EOF")
        .expect_err("nonzero fixture must fail");
        let descendant_pid = std::fs::read_to_string(&descendant_pid)
            .unwrap()
            .trim()
            .to_string();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while unix_process_exists(&descendant_pid) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            !unix_process_exists(&descendant_pid),
            "nonzero command left a descendant alive after its root exited"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn successful_exit_terminates_ignored_stdio_descendants() {
        let _serial = PROCESS_TREE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = tempfile::tempdir().unwrap();
        let descendant_pid = directory.path().join("descendant-pid");
        let mut cmd = Command::new("sh");
        cmd.env("BARO_TEST_DESCENDANT_PID", &descendant_pid)
            .arg("-c")
            .arg(
                "(trap '' TERM; sleep 10) \
                 </dev/null >/dev/null 2>&1 & \
                 echo \"$!\" > \"$BARO_TEST_DESCENDANT_PID\"; exit 0",
            );

        spawn_and_stream_events(cmd, "success-tree-test", |_| {})
            .await
            .expect("successful direct root should still clean descendants");
        let descendant_pid = std::fs::read_to_string(&descendant_pid)
            .unwrap()
            .trim()
            .to_string();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while unix_process_exists(&descendant_pid) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            !unix_process_exists(&descendant_pid),
            "successful command left an ignored-stdio descendant alive"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_stream_supervision_kills_the_process_tree_on_drop() {
        let _serial = PROCESS_TREE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let directory = tempfile::tempdir().unwrap();
        let started = directory.path().join("started");
        let descendant_pid = directory.path().join("descendant-pid");
        let mut cmd = Command::new("sh");
        cmd.env("BARO_TEST_STARTED", &started)
            .env("BARO_TEST_DESCENDANT_PID", &descendant_pid)
            .arg("-c")
            .arg(
                "(trap '' TERM; sleep 10) & \
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

    #[cfg(windows)]
    fn windows_process_exists(pid: u32) -> bool {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if raw.is_null() {
            return false;
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
        match unsafe { WaitForSingleObject(handle.as_raw_handle() as _, 0) } {
            WAIT_TIMEOUT => true,
            WAIT_OBJECT_0 => false,
            _ => false,
        }
    }
}
