//! Thin wrapper that runs `claude --print --output-format json` for
//! the non-streaming Planner call. Spawn/capture/log mechanics live in
//! `crate::subprocess`; this is only the Claude-specific glue
//! (PATH preflight, CLI args, auth-failure hand-holding).

use std::path::PathBuf;

use tokio::process::Command;

use crate::subprocess::{self, ProcessRunError};

/// Configuration for spawning a Claude CLI process in JSON mode.
pub struct ClaudeRunConfig {
    pub prompt: String,
    pub cwd: PathBuf,
    pub model: Option<String>,
    /// Passed as `--effort`; empty string omits the flag (CLI default).
    pub effort: String,
    /// Persisted-log filename tag; defaults to "claude".
    pub log_tag: Option<&'static str>,
}

pub struct ClaudeJsonOutput {
    pub stdout: String,
}

/// Spawn Claude, wait for completion, return raw stdout (JSON wrapper).
/// Both streams are persisted to `~/.baro/runs/` before either branch
/// returns, so even a hard-fail leaves a forensic trail.
pub async fn spawn_claude_json(
    config: &ClaudeRunConfig,
) -> Result<ClaudeJsonOutput, ProcessRunError> {
    // PATH preflight — fail fast with a useful message before we
    // build a 20kB prompt for a binary that isn't installed.
    if which::which("claude").is_err() {
        return Err(ProcessRunError {
            message:
                "`claude` CLI not found on PATH. Install Claude Code from \
                 https://claude.com/code, then run `baro --doctor` to confirm \
                 the install is healthy before retrying."
                    .into(),
            log_path: None,
        });
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
    if !config.effort.is_empty() {
        cmd.arg("--effort").arg(&config.effort);
    }
    cmd.arg("-p").arg(&config.prompt);
    cmd.current_dir(&config.cwd);

    let tag = config.log_tag.unwrap_or("claude");
    let captured = subprocess::spawn_and_capture(cmd, tag)
        .await
        // "empty output" usually means unauthenticated claude; decorate
        // with the hint so the TUI says something useful.
        .map_err(|mut err| {
            if err.message.contains("empty output") {
                err.message = format!(
                    "{} (typically means `claude` is not authenticated — run `baro --doctor` to verify)",
                    err.message
                );
            }
            err
        })?;

    Ok(ClaudeJsonOutput {
        stdout: captured.stdout,
    })
}
