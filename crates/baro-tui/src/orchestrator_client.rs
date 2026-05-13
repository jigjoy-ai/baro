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

use std::path::{Path, PathBuf};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

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
    /// Optional path for the audit JSONL log.
    pub audit_log: Option<PathBuf>,
    /// Enable Critic (Phase 3 live acceptance evaluator). Default: false.
    pub with_critic: bool,
    /// Model for Critic (default "haiku" inside the orchestrator).
    pub critic_model: Option<String>,
    /// Disable Librarian (Phase 2 cross-agent memory). Default: false (Librarian on).
    pub with_librarian: bool,
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
    let entry = locate_entry(&cfg.cwd)?;
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

fn build_command(entry: &EntryPoint, cfg: &OrchestratorConfig) -> Command {
    let mut cmd = match entry {
        EntryPoint::Tsx { tsx, script } => {
            let mut c = Command::new(tsx);
            c.arg(script);
            c
        }
        EntryPoint::NodeJs(js) => {
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
    cmd
}

enum EntryPoint {
    /// Dev path: `tsx scripts/cli.ts`.
    Tsx { tsx: PathBuf, script: PathBuf },
    /// Production path: bundled JS ship-with-npm-package.
    NodeJs(PathBuf),
}

/// Find the orchestrator entry. Searches in this order:
///   1. Sibling of the running binary — i.e. `<exe-dir>/cli.mjs`. This is
///      where baro-ai's postinstall copies the bundled orchestrator
///      (typically `~/.baro/bin/cli.mjs`). Works for global, local, and
///      npx installs because the launcher also lives there.
///   2. Local-install bundle — `<cwd>/node_modules/baro-ai/dist/cli.mjs`.
///      Useful when baro-ai is added as a dependency of the project
///      being orchestrated, before the postinstall has run.
///   3. Dev tsx script — `<repo>/packages/baro-orchestrator/scripts/cli.ts`,
///      discovered by walking up from the binary's location or from cwd.
fn locate_entry(cwd: &Path) -> Result<EntryPoint, String> {
    // (1) Co-located bundle next to the binary itself.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sibling = parent.join("cli.mjs");
            if sibling.exists() {
                return Ok(EntryPoint::NodeJs(sibling));
            }
        }
    }

    // (2) Local-install bundle in the project being orchestrated.
    let bundled = cwd.join("node_modules/baro-ai/dist/cli.mjs");
    if bundled.exists() {
        return Ok(EntryPoint::NodeJs(bundled));
    }

    // (3) Dev tsx — find the baro repo root by walking up from this exe.
    let exe = std::env::current_exe()
        .map_err(|e| format!("cannot read current exe: {}", e))?;
    let mut search_root = exe.parent().map(|p| p.to_path_buf());
    let mut found_repo: Option<PathBuf> = None;
    while let Some(d) = search_root {
        if d
            .join("packages/baro-orchestrator/scripts/cli.ts")
            .exists()
        {
            found_repo = Some(d);
            break;
        }
        search_root = d.parent().map(|p| p.to_path_buf());
    }

    // Also try cwd-based discovery (when running from inside the baro repo).
    let cwd_candidate = cwd.join("packages/baro-orchestrator/scripts/cli.ts");
    let dev_repo = found_repo.or_else(|| {
        if cwd_candidate.exists() {
            Some(cwd.to_path_buf())
        } else {
            None
        }
    });

    let dev_repo = dev_repo.ok_or_else(|| {
        "could not locate baro-orchestrator: no cli.mjs next to the binary, no \
         node_modules/baro-ai/dist/cli.mjs in the project, and no dev tsx \
         script found in a parent baro repo. Try `npm install -g baro-ai` \
         (this triggers postinstall and stages the orchestrator)."
            .to_string()
    })?;
    let tsx = dev_repo.join("node_modules/.bin/tsx");
    let script = dev_repo.join("packages/baro-orchestrator/scripts/cli.ts");
    if !tsx.exists() {
        return Err(format!(
            "tsx not found at {} — run `npm install` in the baro repo",
            tsx.display()
        ));
    }
    Ok(EntryPoint::Tsx { tsx, script })
}
