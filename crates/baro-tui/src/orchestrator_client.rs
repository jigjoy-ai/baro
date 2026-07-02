//! Client for the TS Mozaik orchestrator subprocess: spawns it,
//! streams its stdout (line-delimited BaroEvent JSON) into the TUI's
//! event channel, and surfaces stderr to the operator.

use std::path::PathBuf;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::discovery::{self, ScriptEntry};
use crate::events::BaroEvent;

pub struct OrchestratorConfig {
    pub prd_path: PathBuf,
    pub cwd: PathBuf,
    pub parallel: u32,
    pub timeout_secs: u64,
    pub override_model: Option<String>,
    pub default_model: Option<String>,
    /// Skip the git lifecycle (branch/push).
    pub skip_git: bool,
    /// Path for the audit JSONL log.
    pub audit_log: Option<PathBuf>,
    // NOTE: the with_* fields map to mixed-polarity orchestrator flags —
    // true forwards `--with-critic`/`--with-surgeon`, false forwards
    // `--no-librarian`/`--no-memory`/`--no-sentry`.
    pub with_critic: bool,
    /// Default "haiku" inside the orchestrator.
    pub critic_model: Option<String>,
    pub with_librarian: bool,
    /// Semantic MemoryLibrarian; when off, the tag-based Librarian is used.
    pub with_memory: bool,
    pub with_sentry: bool,
    pub with_surgeon: bool,
    /// LLM Surgeon vs deterministic skip-only.
    pub surgeon_use_llm: bool,
    /// Default "opus" inside the orchestrator.
    pub surgeon_model: Option<String>,
    /// Seconds between story spawns within a DAG level. None → the
    /// orchestrator default (10); Some(0) disables staggering.
    pub intra_level_delay_secs: Option<u64>,
    pub llm: String,
    /// Per-phase overrides, forwarded as `--story-llm` / `--critic-llm` /
    /// `--surgeon-llm` only when they differ from `llm`.
    pub story_llm: String,
    pub critic_llm: String,
    pub surgeon_llm: String,
    /// Injected as `OPENAI_API_KEY` when a phase uses openai; never
    /// written to disk. `None` = inherit whatever is in the parent env.
    pub openai_api_key: Option<String>,
    /// Forwarded as `OPENAI_BASE_URL` when any phase uses OpenAI.
    pub openai_base_url: Option<String>,
    /// Forwarded as `--effort`.
    pub effort: String,
    /// Story-model override; wins over the per-PRD-story `model` field.
    pub story_model: Option<String>,
    /// Per-story tier→backend:model map (`--tier-map`); `None` → tiers
    /// resolve on the phase `llm`.
    pub tier_map: Option<String>,
    /// Named OpenAI-compatible endpoints (`name=url`), each forwarded as
    /// `--openai-endpoint`. Keys are NOT passed here — the orchestrator
    /// resolves `BARO_OPENAI_KEY_<NAME>` / `OPENAI_API_KEY` from its env.
    pub openai_endpoints: Vec<String>,
    /// Headless: echo raw orchestrator stdout lines (event JSON) to our
    /// stdout so CI / remote runners can consume the stream directly.
    pub echo_raw: bool,
}

/// Spawn the orchestrator subprocess and return a channel that receives
/// the BaroEvents it emits. Errors during spawn become a single
/// `StoryError` event so the TUI surfaces them.
pub fn spawn_orchestrator(
    cfg: OrchestratorConfig,
    tx: mpsc::Sender<BaroEvent>,
) {
    tokio::spawn(async move {
        let result = run(cfg, &tx).await;
        let (code, reason) = match result {
            Ok(()) => (Some(0), None),
            Err(err) => {
                let _ = tx
                    .send(BaroEvent::StoryError {
                        id: "_orchestrator".to_string(),
                        error: err.clone(),
                        attempt: 1,
                        max_retries: 1,
                    })
                    .await;
                (None, Some(err))
            }
        };
        // Always tell the TUI the orchestrator is gone, so it can break
        // out of any in-flight "waiting" state and surface a banner.
        let _ = tx
            .send(BaroEvent::OrchestratorExited { code, reason })
            .await;
    });
}

async fn run(
    cfg: OrchestratorConfig,
    tx: &mpsc::Sender<BaroEvent>,
) -> Result<(), String> {
    let entry = discovery::locate_script(
        &cfg.cwd,
        "packages/baro-orchestrator/scripts/cli.ts",
        "cli.mjs",
    )?;
    let mut cmd = build_command(&entry, &cfg);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());
    // If the Rust process dies uncleanly, SIGKILL the child via tokio's
    // Drop rather than orphaning it; the orchestrator's ppid watchdog
    // is the backup if we miss this.
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn orchestrator: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "orchestrator stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "orchestrator stderr missing".to_string())?;

    // Drain stdout: each line is a BaroEvent JSON.
    let stdout_tx = tx.clone();
    let echo_raw = cfg.echo_raw;
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if echo_raw {
                println!("{}", trimmed);
            }
            match serde_json::from_str::<BaroEvent>(trimmed) {
                Ok(ev) => {
                    if stdout_tx.send(ev).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    // Unrecognized output becomes a `_orchestrator` story
                    // log, so older TUIs stay forward-compatible.
                    let _ = stdout_tx
                        .send(BaroEvent::StoryLog {
                            id: "_orchestrator".to_string(),
                            line: format!("[parse-skip] {}", trimmed),
                        })
                        .await;
                }
            }
        }
    });

    // Drain stderr into `_orchestrator` StoryLog lines AND tee to
    // <audit_log>.stderr.txt — the TUI's logs panel is in-memory only,
    // so without the tee a JS crash's stack trace dies with the parent.
    let stderr_tx = tx.clone();
    let stderr_log_path = cfg
        .audit_log
        .as_ref()
        .map(|p| p.with_extension("stderr.txt"));
    let stderr_task = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let mut sink: Option<tokio::fs::File> = None;
        if let Some(p) = &stderr_log_path {
            if let Some(parent) = p.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            sink = tokio::fs::File::create(p).await.ok();
        }
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(f) = sink.as_mut() {
                let _ = f.write_all(line.as_bytes()).await;
                let _ = f.write_all(b"\n").await;
                let _ = f.flush().await;
            }
            let _ = stderr_tx
                .send(BaroEvent::StoryLog {
                    id: "_orchestrator".to_string(),
                    line: trimmed.to_string(),
                })
                .await;
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("orchestrator wait failed: {}", e))?;

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    if !status.success() {
        return Err(format!(
            "orchestrator exited with code {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

fn build_command(entry: &ScriptEntry, cfg: &OrchestratorConfig) -> Command {
    let mut cmd = match entry {
        ScriptEntry::Tsx { tsx, script } => {
            let mut c = Command::new(tsx);
            c.arg(script);
            c
        }
        ScriptEntry::NodeJs(js) => {
            let mut c = Command::new("node");
            c.arg(js);
            c
        }
    };
    cmd.arg("--prd").arg(&cfg.prd_path);
    cmd.arg("--cwd").arg(&cfg.cwd);
    cmd.arg("--parallel").arg(cfg.parallel.to_string());
    cmd.arg("--timeout").arg(cfg.timeout_secs.to_string());
    if let Some(m) = &cfg.override_model {
        cmd.arg("--model").arg(m);
    } else if let Some(m) = &cfg.default_model {
        cmd.arg("--model").arg(m);
    }
    if cfg.skip_git {
        cmd.arg("--no-git");
    }
    if let Some(p) = &cfg.audit_log {
        cmd.arg("--audit-log").arg(p);
    }
    if cfg.with_critic {
        cmd.arg("--with-critic");
    }
    if let Some(m) = &cfg.critic_model {
        cmd.arg("--critic-model").arg(m);
    }
    if !cfg.with_librarian {
        cmd.arg("--no-librarian");
    }
    if !cfg.with_memory {
        cmd.arg("--no-memory");
    }
    if !cfg.with_sentry {
        cmd.arg("--no-sentry");
    }
    if cfg.with_surgeon {
        cmd.arg("--with-surgeon");
    }
    if cfg.surgeon_use_llm {
        cmd.arg("--surgeon-use-llm");
    }
    if let Some(m) = &cfg.surgeon_model {
        cmd.arg("--surgeon-model").arg(m);
    }
    if let Some(d) = cfg.intra_level_delay_secs {
        cmd.arg("--intra-level-delay").arg(d.to_string());
    }
    cmd.arg("--llm").arg(&cfg.llm);
    // Per-phase overrides only sent when they differ from `--llm`,
    // keeping single-backend command lines terse.
    if cfg.story_llm != cfg.llm {
        cmd.arg("--story-llm").arg(&cfg.story_llm);
    }
    if cfg.critic_llm != cfg.llm {
        cmd.arg("--critic-llm").arg(&cfg.critic_llm);
    }
    if cfg.surgeon_llm != cfg.llm {
        cmd.arg("--surgeon-llm").arg(&cfg.surgeon_llm);
    }
    // Only forward an explicitly-provided key — tokio::Command inherits
    // the parent env, so a shell-env key flows through on its own. The
    // key must be available if ANY phase uses openai.
    let tier_map_uses_openai = cfg
        .tier_map
        .as_deref()
        .is_some_and(|m| m.contains("openai:"));
    let uses_openai = cfg.llm == "openai"
        || cfg.story_llm == "openai"
        || cfg.critic_llm == "openai"
        || cfg.surgeon_llm == "openai"
        || tier_map_uses_openai
        || !cfg.openai_endpoints.is_empty();
    if uses_openai {
        if let Some(key) = &cfg.openai_api_key {
            cmd.env("OPENAI_API_KEY", key);
        }
        if let Some(url) = &cfg.openai_base_url {
            cmd.env("OPENAI_BASE_URL", url);
        }
    }
    if let Some(m) = &cfg.story_model {
        cmd.arg("--story-model").arg(m);
    }
    if let Some(tm) = &cfg.tier_map {
        cmd.arg("--tier-map").arg(tm);
    }
    for ep in &cfg.openai_endpoints {
        cmd.arg("--openai-endpoint").arg(ep);
    }
    cmd.arg("--effort").arg(&cfg.effort);
    cmd
}
