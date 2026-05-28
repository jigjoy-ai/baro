//! Thin wrapper that runs `claude --print --output-format json` for
//! the non-streaming Planner call.
//!
//! All the heavy lifting — spawn, capture stdout/stderr, persist log,
//! turn non-zero exit into a typed error — lives in
//! `crate::subprocess`. This file is only Claude-specific glue:
//! the `which::which("claude")` preflight, the Claude CLI args, and
//! a touch of error-message hand-holding for the auth-failure case.

use std::path::PathBuf;

use tokio::process::Command;

use crate::subprocess::{self, ProcessRunError};

/// Configuration for spawning a Claude CLI process in JSON mode.
pub struct ClaudeRunConfig {
    pub prompt: String,
    pub cwd: PathBuf,
    pub model: Option<String>,
    /// Effort level passed as `--effort` (low|medium|high|xhigh|max).
    /// Empty string = omit the flag (use the CLI default).
    pub effort: String,
    /// Short tag for the persisted log filename — "planner" today,
    /// "claude" if you leave it default. Always lowercase-kebab.
    pub log_tag: Option<&'static str>,
}

pub struct ClaudeJsonOutput {
    pub stdout: String,
}

/// Spawn Claude, wait for completion, return raw stdout (JSON wrapper).
/// Stdout + stderr are persisted to `~/.baro/runs/<tag>-<ts>.log` by
/// `subprocess::spawn_and_capture` before either branch returns, so
/// even a hard-fail leaves a forensic trail.
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
        // Decorate the "empty output" failure mode with the
        // Claude-specific hint (auth) so the TUI says something
        // useful instead of "claude exited with code 1 with empty
        // output". This is the issue-#17 case from 0.25.1.
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
