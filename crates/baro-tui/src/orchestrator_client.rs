//! Client for the TypeScript Mozaik orchestrator subprocess.
//!
//! Spawns `tsx scripts/cli.ts` (in dev) from the baro-orchestrator
//! workspace package, streams its stdout (line-delimited BaroEvent JSON)
//! into the same `mpsc::Sender<BaroEvent>` channel the Rust executor
//! used to feed, and surfaces stderr to the operator.
//!
//! When/if the orchestrator is bundled into the published `baro-ai` npm
//! package, this module will look for a precompiled `dist/cli.mjs`
//! before falling back to the dev tsx path.

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
    /// If true, the orchestrator will skip the git lifecycle (branch/push).
    pub skip_git: bool,
    /// If true, the orchestrator skips `gh pr create` at end of run while
    /// keeping branch creation + push. Forwarded as `--no-pr`. Distinct
    /// from `skip_git`, which disables the entire git lifecycle.
    pub skip_pr: bool,
    /// Optional path for the audit JSONL log.
    pub audit_log: Option<PathBuf>,
    /// Enable Critic (Phase 3 live acceptance evaluator). Default: false.
    pub with_critic: bool,
    /// Model for Critic (default "haiku" inside the orchestrator).
    pub critic_model: Option<String>,
    /// Disable Librarian (Phase 2 cross-agent memory). Default: false (Librarian on).
    pub with_librarian: bool,
    /// Disable semantic memory (MemoryLibrarian). Default: false (memory on).
    /// When false and with_librarian is true, uses tag-based Librarian.
    pub with_memory: bool,
    /// Disable Sentry (Phase 2 file conflict detector). Default: false (Sentry on).
    pub with_sentry: bool,
    /// Enable Surgeon (Phase 4 adaptive DAG mutation). Default: false.
    pub with_surgeon: bool,
    /// Use Claude CLI for Surgeon evaluation. Default: false (deterministic).
    pub surgeon_use_llm: bool,
    /// Model for Surgeon LLM (default "opus" inside the orchestrator).
    pub surgeon_model: Option<String>,
    /// Seconds to wait between successive story spawns inside the
    /// same DAG level. Default (when None): 10 inside the orchestrator.
    /// Set to Some(0) to disable staggering.
    pub intra_level_delay_secs: Option<u64>,
    /// LLM provider. "claude" (default) uses the Claude Code CLI;
    /// "openai" routes through Mozaik 3.9's native OpenAI participants.
    /// Currently plumbed end-to-end but the OpenAI siblings are not
    /// wired yet — a request for "openai" silently falls through to
    /// Claude behaviour until the per-phase siblings ship in 0.29+.
    pub llm: String,
    /// Per-phase LLM overrides. Forwarded as `--story-llm` /
    /// `--critic-llm` / `--surgeon-llm` only when they differ from
    /// `llm` — that way pure-claude / pure-codex / pure-openai runs
    /// have a clean command line and the orchestrator's startup
    /// banner stays terse.
    pub story_llm: String,
    pub critic_llm: String,
    pub surgeon_llm: String,
    /// OpenAI API key to inject as `OPENAI_API_KEY` into the
    /// orchestrator subprocess when `llm == "openai"`. The TUI gathers
    /// this from either the user's shell env or the ApiKeyInput
    /// screen; it isn't written to disk. `None` is a no-op (any value
    /// already in the parent env is inherited normally).
    pub openai_api_key: Option<String>,
    /// Optional custom base URL for OpenAI-compatible API endpoints
    /// (e.g. Xiaomi MiMo, OpenRouter, local vLLM). Forwarded as
    /// `OPENAI_BASE_URL` env var when any phase uses OpenAI.
    pub openai_base_url: Option<String>,
    /// Effort level forwarded as `--effort` to the orchestrator
    /// subprocess (applies to the Claude story path). Default "high".
    pub effort: String,
    /// Per-phase model override for StoryAgent — forwarded as
    /// `--story-model X` to the orchestrator subprocess. Wins over
    /// the per-PRD-story `model` field and over the OpenAI default.
    pub story_model: Option<String>,
    /// Per-story tier→backend:model map, forwarded as `--tier-map`.
    /// Binds the planner's blast-radius tiers (haiku/sonnet/opus) to
    /// concrete backends so one DAG can mix claude/openai/codex stories,
    /// e.g. `"haiku=openai:MiniMax-M3,sonnet=openai:MiniMax-M3,opus=claude:opus"`.
    /// `None` → per-story tiers resolve on the phase `llm` as before.
    pub tier_map: Option<String>,
    /// Named OpenAI-compatible endpoints (`name=url`), each forwarded as
    /// a `--openai-endpoint` arg. Lets a route say `openai:model@name`,
    /// so one DAG can hit several OpenAI-compatible endpoints (e.g.
    /// MiniMax + real OpenAI). Keys are NOT passed here — the orchestrator
    /// resolves them from `BARO_OPENAI_KEY_<NAME>` / `OPENAI_API_KEY`,
    /// inherited through the subprocess env.
    pub openai_endpoints: Vec<String>,
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
    // If the Rust process dies before we can ask the orchestrator to
    // shut down cleanly (panic, OS kill), at least make sure the
    // orchestrator child gets SIGKILL'd via tokio's Drop impl rather
    // than orphaning to init. The orchestrator's own ppid watchdog
    // catches the orphan case if we somehow miss this.
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
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<BaroEvent>(trimmed) {
                Ok(ev) => {
                    if stdout_tx.send(ev).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    // Forward unrecognized output as a story log under
                    // `_orchestrator`. Older TUIs are forward-compat.
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

    // Drain stderr: emit each line as a StoryLog under `_orchestrator`
    // so the user can see what the subprocess is doing AND tee every line
    // to <audit_log>.stderr.txt next to the JSONL audit log so a crash's
    // stack trace survives the orchestrator's death. Without that, an
    // unhandled rejection kills the JS process and the stderr lines that
    // describe the failure go nowhere — the TUI's logs panel is in-memory
    // only and dies with the parent.
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
    if cfg.skip_pr {
        cmd.arg("--no-pr");
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
    // Per-phase overrides only sent when they DIFFER from the global
    // `--llm`. Keeps the command line terse on pure-claude /
    // pure-codex / pure-openai runs (no `--story-llm claude` noise
    // when --llm claude already implies it).
    if cfg.story_llm != cfg.llm {
        cmd.arg("--story-llm").arg(&cfg.story_llm);
    }
    if cfg.critic_llm != cfg.llm {
        cmd.arg("--critic-llm").arg(&cfg.critic_llm);
    }
    if cfg.surgeon_llm != cfg.llm {
        cmd.arg("--surgeon-llm").arg(&cfg.surgeon_llm);
    }
    // Only forward an explicitly-provided key. If openai_api_key is
    // None the user might still have the variable in their shell env;
    // tokio::Command inherits parent env by default, so it'll flow
    // through naturally without us touching it.
    // If ANY phase uses openai, the API key needs to be available.
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

// EntryPoint + locate_entry moved to `discovery::ScriptEntry` /
// `discovery::locate_script` — the architect_runner + planner_runner
// share the same shape and the orchestrator now uses the common
// helper to avoid a third copy of the same three-tier search.
