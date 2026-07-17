//! Client for the TS Mozaik orchestrator subprocess: spawns it,
//! streams its stdout (line-delimited BaroEvent JSON) into the TUI's
//! event channel, and surfaces stderr to the operator.

use std::io::Write;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::conversation::ConversationContextSnapshot;
use crate::discovery::{self, ScriptEntry};
use crate::events::BaroEvent;
use crate::subprocess::{configure_process_tree, ProcessTreeGuard};

pub struct OrchestratorConfig {
    /// Accepted-goal conversation continuity for the run-local DialogueAgent.
    /// `run` materializes this only as a private temporary file and keeps the
    /// handle alive for exactly the child-process lifetime.
    pub conversation_context: Option<ConversationContextSnapshot>,
    pub prd_path: PathBuf,
    pub cwd: PathBuf,
    /// Enables the collective-only private Planner stream. Absence preserves
    /// the historical complete-PRD startup path.
    pub progressive_planning_id: Option<String>,
    pub parallel: u32,
    pub timeout_secs: u64,
    pub override_model: Option<String>,
    pub default_model: Option<String>,
    /// Skip the git lifecycle (branch/push).
    pub skip_git: bool,
    /// Path for the audit JSONL log.
    pub audit_log: Option<PathBuf>,
    // NOTE: the with_* fields map to mixed-polarity orchestrator flags.
    // Surgeon and its LLM mode are always forwarded explicitly because the
    // TS CLI defaults both on; omitting a Rust-side false would re-enable it.
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
/// `StoryError` event so the TUI surfaces them. `stdin_rx` lines are
/// written verbatim (newline-terminated) to the child's stdin — the
/// TUI→orchestrator command lane.
pub fn spawn_orchestrator(
    cfg: OrchestratorConfig,
    tx: mpsc::Sender<BaroEvent>,
    stdin_rx: mpsc::Receiver<String>,
) -> oneshot::Sender<()> {
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        let result = run(cfg, &tx, stdin_rx, shutdown_rx).await;
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
    shutdown_tx
}

async fn run(
    cfg: OrchestratorConfig,
    tx: &mpsc::Sender<BaroEvent>,
    mut stdin_rx: mpsc::Receiver<String>,
    shutdown_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let entry = discovery::locate_script(
        &cfg.cwd,
        "packages/baro-orchestrator/scripts/cli.ts",
        "cli.mjs",
    )?;
    let conversation_context_file = cfg
        .conversation_context
        .as_ref()
        .map(EphemeralConversationContextFile::create)
        .transpose()?;
    let mut cmd = build_command(
        &entry,
        &cfg,
        conversation_context_file.as_ref().map(|file| file.path()),
    );
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::piped());
    // If the Rust process dies uncleanly, SIGKILL the child via tokio's
    // Drop rather than orphaning it; the orchestrator's ppid watchdog
    // is the backup if we miss this.
    cmd.kill_on_drop(true);
    configure_process_tree(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn orchestrator: {}", e))?;
    let mut process_tree = ProcessTreeGuard::attach(&mut child)
        .map_err(|e| format!("failed to supervise orchestrator process tree: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "orchestrator stdout missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "orchestrator stderr missing".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "orchestrator stdin missing".to_string())?;

    // Command lane: TUI lines → child stdin. Write errors just end the
    // task — the child exiting is reported through the wait path.
    let stdin_task = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Some(line) = stdin_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

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

    let status = wait_for_child_or_shutdown(&mut child, &mut process_tree, shutdown_rx).await?;
    // Exit status covers only the direct Node process. Kill any residual
    // provider group before draining inherited pipes, including on exit 0.
    process_tree.terminate();

    // Be explicit about the security boundary: the context file remains
    // addressable while the child is alive and is unlinked immediately after
    // it exits, before this run reports completion.
    drop(conversation_context_file);

    // The writer may be parked on recv() forever (the app keeps its
    // sender alive across runs) — abort rather than await.
    stdin_task.abort();
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

/// Wait for the direct orchestrator root or an explicit host shutdown. The
/// latter must terminate the containment primitive before Baro itself exits:
/// on Unix the orchestrator lives in a separate process group, so a terminal
/// SIGINT delivered to Baro does not reach it automatically.
async fn wait_for_child_or_shutdown(
    child: &mut tokio::process::Child,
    process_tree: &mut ProcessTreeGuard,
    mut shutdown_rx: oneshot::Receiver<()>,
) -> Result<std::process::ExitStatus, String> {
    let mut wait = Box::pin(child.wait());
    let shutdown_requested = tokio::select! {
        status = &mut wait => {
            return status.map_err(|e| format!("orchestrator wait failed: {}", e));
        }
        request = &mut shutdown_rx => request.is_ok(),
    };

    if shutdown_requested {
        process_tree.terminate();
    }
    wait.await
        .map_err(|e| format!("orchestrator wait failed: {}", e))
}

struct EphemeralConversationContextFile {
    file: tempfile::NamedTempFile,
}

impl EphemeralConversationContextFile {
    fn create(snapshot: &ConversationContextSnapshot) -> Result<Self, String> {
        let bytes = snapshot
            .json_bytes()
            .map_err(|error| format!("invalid conversation context: {error}"))?;
        let mut file = tempfile::Builder::new()
            .prefix("baro-conversation-context-")
            .suffix(".json")
            .tempfile()
            .map_err(|error| format!("failed to create conversation context file: {error}"))?;
        if !file.path().is_absolute() {
            return Err("conversation context tempfile path is not absolute".to_string());
        }
        file.write_all(&bytes)
            .map_err(|error| format!("failed to write conversation context file: {error}"))?;
        file.as_file_mut()
            .sync_all()
            .map_err(|error| format!("failed to sync conversation context file: {error}"))?;
        Ok(Self { file })
    }

    fn path(&self) -> &Path {
        self.file.path()
    }
}

fn build_command(
    entry: &ScriptEntry,
    cfg: &OrchestratorConfig,
    conversation_context_path: Option<&Path>,
) -> Command {
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
    if let Some(planning_id) = &cfg.progressive_planning_id {
        cmd.arg("--progressive-planning").arg(planning_id);
    }
    if let Some(path) = conversation_context_path {
        debug_assert!(path.is_absolute());
        cmd.arg("--conversation-context-file").arg(path);
    }
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
    cmd.arg(if cfg.with_surgeon {
        "--with-surgeon"
    } else {
        "--no-surgeon"
    });
    cmd.arg(if cfg.surgeon_use_llm {
        "--surgeon-use-llm"
    } else {
        "--no-surgeon-llm"
    });
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
        || !cfg.openai_endpoints.is_empty()
        // Candidate routes live in JSON and are intentionally not duplicated
        // in Rust. Conservatively expose an explicitly-entered TUI key to the
        // trusted orchestrator whenever that market is enabled.
        || std::env::var_os("BARO_COLLECTIVE_WORKERS_FILE").is_some();
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

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::{
        build_command, wait_for_child_or_shutdown, EphemeralConversationContextFile,
        OrchestratorConfig,
    };
    use crate::conversation::{
        ConversationKind, ConversationPhase, ConversationSession, ConversationWireResponse,
        GoalEnvelope,
    };
    use crate::discovery::ScriptEntry;

    fn config(with_surgeon: bool, surgeon_use_llm: bool) -> OrchestratorConfig {
        OrchestratorConfig {
            conversation_context: None,
            prd_path: "prd.json".into(),
            cwd: ".".into(),
            progressive_planning_id: None,
            parallel: 1,
            timeout_secs: 60,
            override_model: None,
            default_model: Some("sonnet".to_string()),
            skip_git: true,
            audit_log: None,
            with_critic: false,
            critic_model: None,
            with_librarian: true,
            with_memory: true,
            with_sentry: true,
            with_surgeon,
            surgeon_use_llm,
            surgeon_model: None,
            intra_level_delay_secs: None,
            llm: "claude".to_string(),
            story_llm: "claude".to_string(),
            critic_llm: "claude".to_string(),
            surgeon_llm: "claude".to_string(),
            openai_api_key: None,
            openai_base_url: None,
            effort: "high".to_string(),
            story_model: None,
            tier_map: None,
            openai_endpoints: vec![],
            echo_raw: false,
        }
    }

    fn command_args(cfg: &OrchestratorConfig) -> Vec<String> {
        let command = build_command(&ScriptEntry::NodeJs("/tmp/cli.mjs".into()), cfg, None);
        command
            .as_std()
            .get_args()
            .map(OsStr::to_string_lossy)
            .map(|arg| arg.into_owned())
            .collect()
    }

    fn count(args: &[String], flag: &str) -> usize {
        args.iter().filter(|arg| arg.as_str() == flag).count()
    }

    #[test]
    fn forwards_exactly_one_flag_for_each_surgeon_polarity() {
        for (with_surgeon, surgeon_use_llm) in
            [(true, true), (true, false), (false, true), (false, false)]
        {
            let args = command_args(&config(with_surgeon, surgeon_use_llm));
            assert_eq!(count(&args, "--with-surgeon"), usize::from(with_surgeon));
            assert_eq!(count(&args, "--no-surgeon"), usize::from(!with_surgeon));
            assert_eq!(
                count(&args, "--surgeon-use-llm"),
                usize::from(surgeon_use_llm),
            );
            assert_eq!(
                count(&args, "--no-surgeon-llm"),
                usize::from(!surgeon_use_llm),
            );
        }
    }

    #[test]
    fn forwards_progressive_planning_only_when_explicitly_configured() {
        let mut cfg = config(true, true);
        assert_eq!(count(&command_args(&cfg), "--progressive-planning"), 0);

        cfg.progressive_planning_id = Some("planning-test-1".to_string());
        let args = command_args(&cfg);
        assert_eq!(count(&args, "--progressive-planning"), 1);
        let position = args
            .iter()
            .position(|arg| arg == "--progressive-planning")
            .expect("progressive flag");
        assert_eq!(
            args.get(position + 1).map(String::as_str),
            Some("planning-test-1")
        );
    }

    #[test]
    fn quick_equivalent_config_explicitly_disables_surgeon() {
        // `--quick` sets `with_surgeon=false` while leaving the configured LLM
        // preference intact. The explicit negative flag is what keeps the TS
        // default-on Surgeon disabled for that single-story run.
        let args = command_args(&config(false, true));
        assert_eq!(count(&args, "--no-surgeon"), 1);
        assert_eq!(count(&args, "--with-surgeon"), 0);
        assert_eq!(count(&args, "--surgeon-use-llm"), 1);
        assert_eq!(count(&args, "--no-surgeon-llm"), 0);
    }

    fn context_snapshot() -> crate::conversation::ConversationContextSnapshot {
        let goal = GoalEnvelope {
            objective: "Carry the accepted conversation into runtime".to_string(),
            constraints: vec!["Keep the file ephemeral".to_string()],
            acceptance_criteria: vec!["Dialogue receives the exact v1 schema".to_string()],
            non_goals: vec!["Do not write context into the PRD".to_string()],
            assumptions: vec!["The PRD is already session-bound".to_string()],
        };
        let mut session = ConversationSession::new("session-tempfile-1").unwrap();
        session.begin_request("request-ready", "Run it").unwrap();
        session
            .apply_response(ConversationWireResponse {
                schema_version: 1,
                session_id: "session-tempfile-1".to_string(),
                request_id: "request-ready".to_string(),
                kind: ConversationKind::Ready,
                message: "The goal is clear.".to_string(),
                questions: vec![],
                goal_envelope: Some(goal),
            })
            .unwrap();
        session.take_ready_handoff().unwrap().unwrap();
        session.transition_to(ConversationPhase::Planning).unwrap();
        session
            .conversation_context_snapshot(None)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn forwards_an_absolute_ephemeral_context_file_and_unlinks_it_on_drop() {
        let context = context_snapshot();
        let file = EphemeralConversationContextFile::create(&context).unwrap();
        let path = file.path().to_path_buf();
        assert!(path.is_absolute());
        assert!(path.is_file());

        let cfg = config(true, true);
        let command = build_command(
            &ScriptEntry::NodeJs("/tmp/cli.mjs".into()),
            &cfg,
            Some(&path),
        );
        let args: Vec<String> = command
            .as_std()
            .get_args()
            .map(OsStr::to_string_lossy)
            .map(|arg| arg.into_owned())
            .collect();
        let flag = args
            .iter()
            .position(|arg| arg == "--conversation-context-file")
            .unwrap();
        assert_eq!(
            args.get(flag + 1),
            Some(&path.to_string_lossy().into_owned())
        );
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["schemaVersion"], 1);
        assert_eq!(persisted["sessionId"], "session-tempfile-1");

        drop(file);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn explicit_shutdown_reaps_the_orchestrator_process_group() {
        use crate::subprocess::{configure_process_tree, ProcessTreeGuard};

        let directory = tempfile::tempdir().unwrap();
        let started = directory.path().join("started");
        let descendant_pid_path = directory.path().join("descendant-pid");
        let mut command = tokio::process::Command::new("sh");
        command
            .kill_on_drop(true)
            .env("BARO_TEST_STARTED", &started)
            .env("BARO_TEST_DESCENDANT_PID", &descendant_pid_path)
            .arg("-c")
            .arg(
                "(trap '' TERM; sleep 30) & \
                 echo \"$!\" > \"$BARO_TEST_DESCENDANT_PID\"; \
                 touch \"$BARO_TEST_STARTED\"; wait",
            );
        configure_process_tree(&mut command);
        let mut child = command.spawn().expect("spawn process-tree fixture");
        let mut process_tree = ProcessTreeGuard::attach(&mut child).unwrap();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        let trigger = tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            while !started.exists() && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            assert!(started.exists(), "fixture root never became ready");
            shutdown_tx
                .send(())
                .expect("shutdown receiver must be live");
        });

        let _status = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            wait_for_child_or_shutdown(&mut child, &mut process_tree, shutdown_rx),
        )
        .await
        .expect("structured shutdown must not hang")
        .expect("orchestrator wait should succeed");
        trigger.await.unwrap();

        let descendant_pid = std::fs::read_to_string(&descendant_pid_path)
            .expect("fixture did not record its descendant")
            .trim()
            .to_string();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while unix_process_exists(&descendant_pid) && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            !unix_process_exists(&descendant_pid),
            "headless shutdown left an orchestrator descendant alive"
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
