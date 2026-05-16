//! Spawn an external command, capture stdout + stderr, persist a
//! timestamped log to `~/.baro/runs/<tag>-<unix_secs>.log`, and turn
//! a non-zero exit into a structured error that carries the log path.
//!
//! Three Rust callers go through this — `claude_runner` for the
//! Claude CLI, `architect_runner` for the TS Architect subprocess,
//! and (Phase 5) `planner_runner` for the TS Planner. They all want
//! the same observability story: the user gets a one-line summary in
//! the TUI plus a "full log: …" pointer to a file on disk.
//!
//! Generic on purpose. Knows nothing about Claude or Mozaik or
//! planner phases — the caller passes in a fully-built `tokio::process::
//! Command` and a tag for the log filename.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::process::Command;

/// Captured output of a successful subprocess run.
///
/// stderr isn't surfaced as a field because no caller reads it on
/// the success path — it's already in the persisted log file at
/// `log_path` if you need to see it after the fact.
pub struct CapturedOutput {
    pub stdout: String,
    /// Path of the persisted `~/.baro/runs/<tag>-<ts>.log`. `None`
    /// only when persistence itself failed (e.g. `HOME` unset, dir
    /// not writable) — we never fail the run just because logging
    /// didn't take.
    pub log_path: Option<PathBuf>,
}

/// Subprocess failure — non-zero exit or spawn error.
///
/// `message` is the single-line human-readable summary the TUI
/// surfaces. `log_path` points at the full stdout+stderr log on
/// disk; callers downcast to this type to extract it.
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

/// Spawn `cmd`, wait for completion, capture both streams, persist a
/// log. Returns `CapturedOutput` on `exit 0`, `ProcessRunError` on
/// non-zero or spawn failure.
///
/// `log_tag` becomes the prefix of the on-disk log filename — pick a
/// short kebab string ("claude", "architect", "planner-openai"…)
/// that makes it findable when the user is digging through
/// `~/.baro/runs/`.
pub async fn spawn_and_capture(
    mut cmd: Command,
    log_tag: &str,
) -> Result<CapturedOutput, ProcessRunError> {
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let output = cmd
        .spawn()
        .map_err(|e| ProcessRunError {
            message: format!("failed to spawn {}: {}", log_tag, e),
            log_path: None,
        })?
        .wait_with_output()
        .await
        .map_err(|e| ProcessRunError {
            message: format!("{} process error: {}", log_tag, e),
            log_path: None,
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let log_path = persist_log(log_tag, &stdout, &stderr);

    if !output.status.success() {
        let code = output.status.code();
        return Err(ProcessRunError {
            message: format!(
                "{} exited with code {}{}",
                log_tag,
                code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                detail_tail(&stdout, &stderr),
            ),
            log_path,
        });
    }

    let _ = stderr; // captured in the log file on disk
    Ok(CapturedOutput { stdout, log_path })
}

/// Append the tail of stderr (or stdout fallback) to a "<tag> exited
/// with code N" message. Surfaces the "empty output" case explicitly
/// because that's the failure mode where stock error messages
/// (`No such file or directory`, exit code 1 with no body) tell the
/// user nothing useful — see baro issue #17.
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
/// Returns the path on success, `None` if anything went wrong — we'd
/// rather lose the log than crash the run.
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
    let body = format!(
        "=== STDOUT ===\n{}\n\n=== STDERR ===\n{}\n",
        stdout, stderr,
    );
    if std::fs::write(&path, body).is_err() {
        return None;
    }
    Some(path)
}
