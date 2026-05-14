//! Thin wrapper around `claude --print --output-format json` for the
//! non-streaming planner / architect steps in main.rs.
//!
//! The streaming-json variant lived here too, but the TS Mozaik
//! orchestrator now owns story execution end-to-end so the streaming
//! half is gone. This file is a single-shot run helper.
//!
//! Persists stdout + stderr to a timestamped log file under
//! `~/.baro/runs/` before returning, so even when Claude exits non-
//! zero with empty stderr (the issue #17 scenario — unauthenticated
//! CLI), the user has somewhere to look for the actual failure detail.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::process::Command;

use crate::utils::BaroResult;

/// Configuration for spawning a Claude CLI process in JSON mode.
pub struct ClaudeRunConfig {
    pub prompt: String,
    pub cwd: PathBuf,
    pub model: Option<String>,
    /// Short tag used in the persisted log filename, e.g. "planner"
    /// or "architect". Always lowercase-kebab. If None, defaults to
    /// "claude" and the log goes to `claude-<ts>.log`.
    pub log_tag: Option<&'static str>,
}

/// Output from a non-streaming (JSON mode) Claude invocation. The log
/// file is persisted as a side effect of spawn_claude_json; we don't
/// surface its path on the success path because nothing in the TUI
/// reads it. If a caller ever needs it, add the field then.
pub struct ClaudeJsonOutput {
    pub stdout: String,
}

/// Error returned by spawn_claude_json. Carries the rendered message
/// (for the TUI's error box) and the path to the persisted stdout+
/// stderr log file (for the "full log: …" hint). Other detail (raw
/// stdout / stderr / exit code) lives in the log file on disk; we
/// deliberately don't keep duplicate copies in memory.
#[derive(Debug)]
pub struct ClaudeRunError {
    pub message: String,
    pub log_path: Option<PathBuf>,
}

impl std::fmt::Display for ClaudeRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ClaudeRunError {}

/// Spawn Claude with `--print --output-format json`, wait for completion,
/// return the raw stdout. Writes both stdout and stderr to
/// `~/.baro/runs/<tag>-<unix_secs>.log` before returning so a failed
/// run leaves a forensic trail even when stderr was empty.
pub async fn spawn_claude_json(config: &ClaudeRunConfig) -> BaroResult<ClaudeJsonOutput> {
    // Preflight: confirm `claude` is reachable before we build a 20kB
    // prompt and start a subprocess that will explode with a less
    // helpful "No such file or directory" if it isn't. Pure PATH
    // lookup, no subprocess.
    if which::which("claude").is_err() {
        return Err(
            "`claude` CLI not found on PATH. Install Claude Code from \
             https://claude.com/code, then run `baro --doctor` to confirm \
             the install is healthy before retrying."
                .into(),
        );
    }

    let mut cmd = Command::new("claude");
    cmd.args([
        "--print",
        "--dangerously-skip-permissions",
        "--output-format",
        "json",
    ]);
    if let Some(ref m) = config.model {
        cmd.arg("--model").arg(m);
    }
    cmd.arg("-p").arg(&config.prompt);
    cmd.current_dir(&config.cwd);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let output = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?
        .wait_with_output()
        .await
        .map_err(|e| format!("Claude process error: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let log_path = persist_log(config.log_tag.unwrap_or("claude"), &stdout, &stderr);

    if !output.status.success() {
        let code = output.status.code();
        let detail_tail = build_detail(&stdout, &stderr);
        let message = format!(
            "Claude exited with code {}{}",
            code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            detail_tail,
        );
        return Err(Box::new(ClaudeRunError { message, log_path }));
    }

    Ok(ClaudeJsonOutput { stdout })
}

/// Build the human-readable bit that follows "Claude exited with code N"
/// in the error message. Prefers stderr if present, falls back to stdout
/// (some Claude CLI versions write auth errors there), and surfaces the
/// "empty output" case explicitly because that's the case where the old
/// error message was useless.
fn build_detail(stdout: &str, stderr: &str) -> String {
    let stderr_trim = stderr.trim();
    let stdout_trim = stdout.trim();
    if !stderr_trim.is_empty() {
        format!(": {}", stderr_trim)
    } else if !stdout_trim.is_empty() {
        format!(": (no stderr) stdout: {}", stdout_trim)
    } else {
        " with empty output (typically means `claude` is not authenticated — run `baro --doctor` to verify)".to_string()
    }
}

/// Append stdout + stderr to a timestamped log file under
/// `~/.baro/runs/`. Returns the path on success, None if the write
/// failed (we'd rather lose the log than crash the run).
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
