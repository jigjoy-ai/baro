//! Spawn an external command, capture stdout + stderr, persist a
//! timestamped log to `~/.baro/runs/<tag>-<unix_secs>.log`, and turn
//! a non-zero exit into a structured error carrying the log path.
//! Deliberately generic: the caller passes a fully-built `Command`
//! and a tag for the log filename.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::process::Command;

/// Captured output of a successful subprocess run. stderr isn't a
/// field — no caller reads it on the success path; it's in the log.
pub struct CapturedOutput {
    pub stdout: String,
    /// Persisted log path. `None` only when persistence itself failed —
    /// we never fail the run just because logging didn't take.
    pub log_path: Option<PathBuf>,
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

/// Spawn `cmd`, wait for completion, capture both streams, persist a
/// log. `log_tag` becomes the log-filename prefix — pick a short
/// kebab string ("claude", "architect", …).
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
    let body = format!(
        "=== STDOUT ===\n{}\n\n=== STDERR ===\n{}\n",
        stdout, stderr,
    );
    if std::fs::write(&path, body).is_err() {
        return None;
    }
    Some(path)
}
