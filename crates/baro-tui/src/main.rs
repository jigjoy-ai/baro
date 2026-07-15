mod app;
mod architect_runner;
mod branch_authority;
mod cli;
mod config;
mod constants;
mod context;
mod conversation;
mod conversation_frontdoor;
mod conversation_host;
mod conversation_runner;
mod dag_state;
mod discovery;
mod doctor;
mod events;
mod executor;
mod gateway_credential;
mod git;
mod headless_transport;
mod intake_runner;
mod notification;
mod orchestrator_client;
mod planner_host;
mod planner_runner;
mod planner_stream_bridge;
mod preaccept_context;
mod progressive_planning;
mod resume;
mod review_refiner;
mod screens;
mod service;
mod subprocess;
mod theme;
mod ui;
mod utils;

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crossterm::{
    execute,
    terminal::{
        disable_raw_mode, enable_raw_mode, Clear, ClearType, EnterAlternateScreen,
        LeaveAlternateScreen,
    },
};
use ratatui::{backend::CrosstermBackend, Terminal};
use tokio::sync::mpsc;

use app::{App, Planner, ReviewStory, Screen};
use conversation::{ConversationKind, ConversationPhase, ConversationWireResponse};
use conversation_frontdoor::{
    apply_or_close_conversation_response, architect_clarification_response,
    close_failed_initial_request, spawn_conversation_architect_validation,
    supports_preaccept_architect_outcome, PrevalidatedArchitect,
};
use conversation_host::{
    attach_conversation_metadata, begin_conversation_execution, fail_conversation_run,
    finish_conversation_run, persist_conversation, restore_conversation_from_prd,
    restore_pre_prd_conversation,
};
use events::BaroEvent;
use headless_transport::StdinHub;
pub(crate) use planner_host::PrdOutput;
use planner_host::{PlannerOutcome, PlannerRunSpec, ProgressivePlannerRuntime};

const JIGJOY_STRONG_MODEL: &str = "glm-5.2";
const JIGJOY_CHEAP_STORY_MODEL: &str = "deepseek-v4-flash";
const JIGJOY_HEAVY_STORY_MODEL: &str = "deepseek-v4-pro";
const JIGJOY_GATEWAY_URL: &str = "https://gw.baro.jigjoy.ai/v1";

fn preferred_jigjoy_gateway_key(
    jigjoy_key: Option<String>,
    openai_key: Option<String>,
) -> Option<String> {
    jigjoy_key
        .filter(|value| !value.is_empty())
        // Compatibility fallback for operators who historically placed a
        // JigJoy gateway token in OPENAI_API_KEY directly.
        .or_else(|| openai_key.filter(|value| !value.is_empty()))
}

fn is_signed_jigjoy_gateway_key(value: &str) -> bool {
    value.starts_with("hk_") || value.starts_with("gk_v1.")
}

fn legacy_hosted_run_id(value: &str) -> Option<&str> {
    let payload = value.strip_prefix("hk_")?.split_once('.')?.0;
    let run_id = payload.split_once('~')?.1;
    (!run_id.is_empty() && run_id.len() <= 128).then_some(run_id)
}

fn local_client_run_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("run-local-client-{nanos}-{}", std::process::id())
}

fn preferred_jigjoy_gateway_url(
    explicit_openai_base_url: Option<String>,
    jigjoy_url: Option<String>,
) -> String {
    explicit_openai_base_url
        .filter(|value| !value.is_empty())
        .or_else(|| jigjoy_url.filter(|value| !value.is_empty()))
        .unwrap_or_else(|| JIGJOY_GATEWAY_URL.to_string())
}

fn reconcile_jigjoy_phase_overrides(
    app: &mut App,
    architect_model_explicit: bool,
    planner_model_explicit: bool,
    critic_model_explicit: bool,
    surgeon_model_explicit: bool,
    tier_map_explicit: bool,
) {
    if app.architect_llm != app::LlmProvider::OpenAI && !architect_model_explicit {
        app.architect_model = None;
    }
    if app.planner_llm != app::LlmProvider::OpenAI && !planner_model_explicit {
        app.planner_model = None;
    }
    if app.critic_llm != app::LlmProvider::OpenAI && !critic_model_explicit {
        app.critic_model = None;
    }
    if app.surgeon_llm != app::LlmProvider::OpenAI && !surgeon_model_explicit {
        app.surgeon_model = None;
    }
    if app.story_llm != app::LlmProvider::OpenAI && !tier_map_explicit {
        app.tier_map = None;
    }
}

fn unsupported_critic_backend(enabled: bool, provider: app::LlmProvider) -> Option<&'static str> {
    (enabled && provider == app::LlmProvider::Codex).then_some(
        "Critic cannot use the Codex CLI safely because it has no tool-less inference mode. Use --critic-llm claude|openai|opencode|pi or --no-critic.",
    )
}

const CODEX_CRITIC_AUTO_DISABLED_WARNING: &str =
    "Critic was disabled because the Codex CLI has no safe tool-less inference mode. \
     Architect, Planner, Story, and Surgeon still use Codex. To enable review, route only \
     Critic through --critic-llm claude|openai|opencode|pi.";

/// Disable only the *implicit* Codex Critic default.
///
/// Codex remains valid for the agentic phases, but Critic consumes untrusted
/// repository evidence and therefore requires a tool-less backend. An explicit
/// request must fail closed later through `unsupported_critic_backend`; silently
/// overriding it would hide a configuration error from the operator.
fn disable_implicit_codex_critic(
    app: &mut App,
    critic_explicitly_requested: bool,
    critic_backend_explicitly_set: bool,
) -> bool {
    if app.with_critic
        && app.critic_llm == app::LlmProvider::Codex
        && !critic_explicitly_requested
        && !critic_backend_explicitly_set
    {
        app.with_critic = false;
        true
    } else {
        false
    }
}

/// Apply an interactive primary-provider choice without clobbering a
/// deliberate per-phase Critic route.
fn apply_primary_provider_choice(
    app: &mut App,
    provider: app::LlmProvider,
    critic_backend_explicitly_set: bool,
) {
    app.llm = provider;
    app.architect_llm = provider;
    app.planner_llm = provider;
    app.story_llm = provider;
    if !critic_backend_explicitly_set {
        app.critic_llm = provider;
    }
    app.surgeon_llm = provider;
    app.planner = match provider {
        app::LlmProvider::Claude => app::Planner::Claude,
        app::LlmProvider::OpenAI => app::Planner::OpenAI,
        app::LlmProvider::Codex => app::Planner::Codex,
        app::LlmProvider::OpenCode => app::Planner::OpenCode,
        app::LlmProvider::Pi => app::Planner::Pi,
    };
}

fn review_stories_from_prd(prd: &executor::PrdFile) -> Vec<ReviewStory> {
    prd.user_stories
        .iter()
        .map(|s| ReviewStory {
            id: s.id.clone(),
            priority: s.priority,
            title: s.title.clone(),
            description: s.description.clone(),
            depends_on: s.depends_on.clone(),
            retries: s.retries,
            acceptance: s.acceptance.clone(),
            tests: s.tests.clone(),
            completed: s.passes,
            model: s.model.clone(),
        })
        .collect()
}

fn executor_config_from_app(app: &App) -> Result<executor::ExecutorConfig, String> {
    // Runtime Dialogue is a collective participant. Legacy still uses the
    // same conversation-first intake and durable GoalEnvelope, but must not
    // receive a context flag that the legacy orchestrator correctly rejects.
    let conversation_context = if current_coordination_has_runtime_dialogue() {
        app.conversation
            .conversation_context_snapshot(None)
            .map_err(|error| error.to_string())?
    } else {
        None
    };
    Ok(executor::ExecutorConfig {
        parallel: app.parallel_limit,
        timeout_secs: app.timeout_secs,
        model_routing: app.model_routing,
        override_model: app.override_model.clone(),
        with_critic: app.with_critic,
        critic_model: app.critic_model.clone(),
        with_librarian: app.with_librarian,
        with_memory: app.with_memory,
        with_sentry: app.with_sentry,
        with_surgeon: app.with_surgeon,
        surgeon_use_llm: app.surgeon_use_llm,
        surgeon_model: app.surgeon_model.clone(),
        intra_level_delay_secs: app.intra_level_delay_secs,
        llm: app.llm,
        story_llm: app.story_llm,
        critic_llm: app.critic_llm,
        surgeon_llm: app.surgeon_llm,
        openai_api_key: app.openai_api_key.clone(),
        openai_base_url: app.openai_base_url.clone(),
        effort: app.effort.clone(),
        story_model: app.story_model.clone(),
        tier_map: app.tier_map.clone(),
        openai_endpoints: app.openai_endpoints.clone(),
        conversation_context,
    })
}

fn coordination_has_runtime_dialogue(mode: &str) -> bool {
    mode == "collective"
}

fn current_coordination_has_runtime_dialogue() -> bool {
    std::env::var("BARO_COORDINATION").is_ok_and(|mode| coordination_has_runtime_dialogue(&mode))
}

fn progressive_planning_enabled(headless: bool) -> bool {
    let coordination =
        std::env::var("BARO_COORDINATION").unwrap_or_else(|_| "collective".to_string());
    progressive_planning::progressive_planning_enabled(headless, &coordination, false)
}

enum AppEvent {
    Baro(BaroEvent),
    Key(crossterm::event::KeyEvent),
    ContextReady(String),
    ContextError(String),
    ConversationResponse(ConversationWireResponse),
    /// A conversation `ready` response is only a candidate until the
    /// repository-aware Architect validates it. The durable session keeps one
    /// pending response slot: either this candidate or an Architect-authored
    /// clarification consumes it, never both.
    ConversationArchitectOutcome {
        candidate: ConversationWireResponse,
        repository_context: String,
        transport: architect_runner::ArchitectOutcomeTransportV1,
    },
    ConversationError {
        request_id: String,
        error: String,
        log_path: Option<std::path::PathBuf>,
    },
    /// Architect + intake are complete. Headless progressive mode now opens
    /// the empty collective bootstrap before starting Planner.
    ProgressivePlanningPrepared(PlannerRunSpec),
    /// The host boundary normalizes legacy/progressive success and failure;
    /// this loop only applies the result to App state.
    PlannerFinished(PlannerOutcome),
    /// Intake finished (`--mode auto`, interactive): show the ModePicker.
    IntakeReady {
        decision_doc: Option<String>,
        contract_json: String,
    },
    RefineReady(
        u64,
        Vec<ReviewStory>,
        String,
        String,
        String,
        Option<serde_json::Value>,
    ),
    RefineError(u64, String),
    BranchError(String),
    /// Payload is the suffixed branch name the async git task settled
    /// on; the handler updates `app.branch_name` so the TUI shows the
    /// actual branch, not the pre-suffix name from the planner.
    BranchReady(String),
    /// A `@baro-progress` line streamed from the planner/architect
    /// subprocess during the otherwise-silent planning wait.
    PlanProgress(String),
    ArchitectStarted,
    ArchitectComplete(String), // decision document (markdown)
    ArchitectSkipped(String),  // reason (not fatal — planner will still run)
    /// Handle to the live orchestrator's stdin (JSON command lines);
    /// arrives once per spawn, replacing any stale handle from a
    /// previous run.
    OrchestratorStdin(mpsc::Sender<String>),
    Tick,
}

/// The focus zone ↑↓ should act on: explorer zones only count while the
/// explorer is actually on screen at the current terminal width.
fn effective_focus(
    app: &app::App,
    terminal: &Terminal<CrosstermBackend<Box<dyn Write>>>,
) -> app::WorkbenchFocus {
    let width = terminal.size().map(|s| s.width).unwrap_or(120);
    if app.explorer_visible && width >= screens::execute::BP_EXPLORER {
        app.focus
    } else {
        app::WorkbenchFocus::Main
    }
}

fn open_terminal_writer() -> io::Result<Box<dyn Write>> {
    #[cfg(unix)]
    {
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")?;
        Ok(Box::new(f))
    }
    #[cfg(not(unix))]
    {
        Ok(Box::new(io::stdout()))
    }
}

/// Display fields of a ModeContract; the raw JSON stays authoritative.
#[derive(serde::Deserialize)]
struct ModeContractView {
    mode: String,
    #[serde(default)]
    confidence: f64,
    #[serde(default)]
    reason: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `baro connect [--token …] [--workspace …]` — run as a baro-cloud runner.
    // Handled before clap / the session lock so it bypasses the TUI entirely.
    let raw_args: Vec<String> = std::env::args().collect();
    if raw_args.get(1).map(|s| s.as_str()) == Some("connect") {
        return run_connect(&raw_args[2..]).await;
    }
    // `baro login` — browser-based sign in/up; stores a credential so `baro connect`
    // pairs with no token to paste. Handled before clap, like connect.
    if raw_args.get(1).map(|s| s.as_str()) == Some("login") {
        return run_login().await;
    }

    // Update notice: the network check runs in the JS layer (no HTTP dep
    // here); this reads its cache. Printed AFTER the TUI restores the
    // terminal (below) — the alternate screen purges it.
    let update_notice = notify_update();

    let (cli, _lock) = cli::cli::parse()?;
    std::env::set_var("BARO_COORDINATION", &cli.coordination);
    if cli.local_only {
        std::env::set_var("BARO_LOCAL_ONLY", "1");
    }
    if let Some(value) = &cli.collective_workers {
        std::env::set_var("BARO_COLLECTIVE_WORKERS_FILE", value);
    }
    if let Some(value) = cli.collective_bid_window_ms {
        std::env::set_var("BARO_COLLECTIVE_BID_WINDOW_MS", value.to_string());
    }
    if let Some(value) = cli.collective_min_success {
        std::env::set_var("BARO_COLLECTIVE_MIN_SUCCESS", value.to_string());
    }
    if let Some(value) = cli.collective_max_cost_usd {
        std::env::set_var("BARO_COLLECTIVE_MAX_COST_USD", value.to_string());
    }
    if let Some(value) = cli.collective_max_latency_ms {
        std::env::set_var("BARO_COLLECTIVE_MAX_LATENCY_MS", value.to_string());
    }
    if cli.with_dialogue {
        std::env::set_var("BARO_WITH_DIALOGUE", "1");
    }
    if let Some(value) = &cli.dialogue_llm {
        std::env::set_var("BARO_DIALOGUE_LLM", value);
    }
    if let Some(value) = &cli.dialogue_model {
        std::env::set_var("BARO_DIALOGUE_MODEL", value);
    }

    // --doctor short-circuits before any TUI setup — it must work even
    // when the things a real run depends on (e.g. claude auth) are broken.
    if cli.doctor {
        std::process::exit(doctor::run().await);
    }

    // Headless: no terminal / alternate screen. Drive the run and stream
    // the orchestrator's event JSON to stdout (CI / automation / remote runner).
    if cli.headless {
        let result = run_app(None, cli).await;
        if let Err(err) = result {
            eprintln!("Error: {}", err);
            std::process::exit(1);
        }
        return Ok(());
    }

    let mut writer = open_terminal_writer()?;
    enable_raw_mode()?;
    execute!(writer, EnterAlternateScreen)?;
    execute!(writer, Clear(ClearType::All))?;
    execute!(writer, Clear(ClearType::Purge))?;
    let backend = CrosstermBackend::new(writer);
    let mut terminal = Terminal::new(backend)?;

    let result = run_app(Some(&mut terminal), cli).await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    terminal.backend_mut().flush()?;

    // Terminal is restored now — safe to print the update notice so it survives on screen.
    if let Some(n) = &update_notice {
        eprint!("{n}");
    }

    // _lock is dropped here, removing baro.lock

    if let Err(err) = result {
        eprintln!("Error: {}", err);
        std::process::exit(1);
    }

    Ok(())
}

/// True if version `a` is older than `b` (numeric, per dotted segment).
fn semver_lt(a: &str, b: &str) -> bool {
    let p = |s: &str| {
        s.split('.')
            .map(|x| x.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (pa, pb) = (p(a), p(b));
    for i in 0..3 {
        let (x, y) = (
            pa.get(i).copied().unwrap_or(0),
            pb.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x < y;
        }
    }
    false
}

/// Read the update cache the JS layer maintains (`~/.baro/update-check.json`)
/// and return — not print — a banner if a newer baro is published; the caller
/// prints it after the TUI restores the terminal. Kicks off a detached cache
/// refresh when stale. Best-effort — never blocks or fails.
fn notify_update() -> Option<String> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let cache = std::path::PathBuf::from(home)
        .join(".baro")
        .join("update-check.json");
    let mut fresh = false;
    let mut notice = None;
    if let Ok(s) = std::fs::read_to_string(&cache) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            let latest = v.get("latest").and_then(|x| x.as_str()).unwrap_or("");
            let checked = v.get("checkedAt").and_then(|x| x.as_u64()).unwrap_or(0);
            if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
                fresh = (now.as_millis() as u64).saturating_sub(checked) < 3 * 3600 * 1000;
            }
            if !latest.is_empty() && semver_lt(env!("CARGO_PKG_VERSION"), latest) {
                notice = Some(format!(
                    "\n  \u{2191} a newer baro is available: {} \u{2192} {}\n    update:  npm i -g baro-ai\n",
                    env!("CARGO_PKG_VERSION"),
                    latest,
                ));
            }
        }
    }
    if !fresh {
        spawn_bg_update_check();
    }
    notice
}

/// Fire-and-forget the JS update check so the cache refreshes for next time.
fn spawn_bg_update_check() {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let Ok(entry) = discovery::locate_script(
        &cwd,
        "packages/baro-orchestrator/scripts/runner.ts",
        "runner.mjs",
    ) else {
        return;
    };
    let mut cmd = match &entry {
        discovery::ScriptEntry::Tsx { tsx, script } => {
            let mut c = std::process::Command::new(tsx);
            c.arg(script);
            c
        }
        discovery::ScriptEntry::NodeJs(js) => {
            let mut c = std::process::Command::new("node");
            c.arg(js);
            c
        }
    };
    cmd.env("BARO_CHECK_UPDATE", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let _ = cmd.spawn(); // detached: don't wait, ignore errors
}

/// `baro login` — browser-based device auth. Spawns the bundled runner in login mode;
/// it opens the browser, polls the control plane, and stores a credential under ~/.baro
/// so later `baro connect` needs no token. CONTROL_URL is inherited from the env if set.
async fn run_login() -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let entry = discovery::locate_script(
        &cwd,
        "packages/baro-orchestrator/scripts/runner.ts",
        "runner.mjs",
    )
    .map_err(|e| {
        format!("could not locate the runner bundle ({e}). Reinstall: npm install -g baro-ai")
    })?;
    let mut cmd = match &entry {
        discovery::ScriptEntry::Tsx { tsx, script } => {
            let mut c = tokio::process::Command::new(tsx);
            c.arg(script);
            c
        }
        discovery::ScriptEntry::NodeJs(js) => {
            let mut c = tokio::process::Command::new("node");
            c.arg(js);
            c
        }
    };
    cmd.env("BARO_LOGIN", "1");
    let status = cmd
        .spawn()
        .map_err(|e| format!("failed to start login: {e}"))?
        .wait()
        .await?;
    std::process::exit(status.code().unwrap_or(1));
}

/// `baro connect` — run as a baro-cloud runner. Spawns the bundled runner.mjs,
/// which pairs with the control plane and runs each dispatched goal via
/// `baro --headless` over the user's subscription.
async fn run_connect(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let mut token = std::env::var("RUNNER_TOKEN").ok();
    let mut workspace = std::env::var("WORKSPACE_DIR").ok();
    let mut control_url = std::env::var("CONTROL_URL").ok();
    let mut install = false;
    let mut uninstall = false;
    // Single-run mode for ephemeral cloud workers: take exactly one
    // dispatched run, then exit — no reconnect loop.
    let mut once = std::env::var("BARO_RUN_ONCE").as_deref() == Ok("1");
    // Set by the managed service invocation → the runner may self-update + exit-to-restart.
    let mut service = std::env::var("BARO_SERVICE").as_deref() == Ok("1");
    // Suppress the runner's post-pairing "install a background service?" prompt.
    let mut no_service_prompt = std::env::var("BARO_NO_SERVICE_PROMPT").as_deref() == Ok("1");
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--service" => {
                service = true;
                i += 1;
            }
            "--token" => {
                token = args.get(i + 1).cloned();
                i += 2;
            }
            "--workspace" | "--cwd" => {
                workspace = args.get(i + 1).cloned();
                i += 2;
            }
            "--control-url" => {
                control_url = args.get(i + 1).cloned();
                i += 2;
            }
            "--install-service" => {
                install = true;
                i += 1;
            }
            "--uninstall-service" => {
                uninstall = true;
                i += 1;
            }
            "--once" => {
                once = true;
                i += 1;
            }
            "--no-service" => {
                no_service_prompt = true;
                i += 1;
            }
            "-h" | "--help" => {
                println!("Usage: baro connect [--token <rt_…>] [--workspace <git repo>]");
                println!("Pairs this machine with baro-cloud and runs dispatched goals over your subscription.");
                println!("Run `baro login` first and the token is optional — connect signs in automatically.");
                println!();
                println!("  --install-service    install a background service (launchd/systemd/Task Scheduler)");
                println!("                       so the runner survives terminal close, logout, and reboot");
                println!("  --uninstall-service  remove that service");
                println!("  --no-service         don't offer to install the background service after pairing");
                println!("  --once               run exactly one dispatched goal, then exit (cloud workers)");
                return Ok(());
            }
            _ => i += 1,
        }
    }

    // Uninstall is independent of token/workspace.
    if uninstall {
        return service::uninstall();
    }

    let workspace = workspace.unwrap_or_else(|| ".".to_string());
    let cwd = std::fs::canonicalize(&workspace)
        .map_err(|e| format!("workspace '{}' not found: {}", workspace, e))?;

    // Install the background service (token + workspace baked in) and exit —
    // the service itself runs `baro connect` for real, in the background.
    if install {
        let exe =
            std::env::current_exe().map_err(|e| format!("cannot resolve baro binary: {e}"))?;
        let token =
            token.ok_or("--install-service needs --token <rt_…> (get one from the dashboard)")?;
        return service::install(&service::ServiceConfig {
            exe,
            token,
            workspace: cwd,
            control_url,
        });
    }

    let entry = discovery::locate_script(
        &cwd,
        "packages/baro-orchestrator/scripts/runner.ts",
        "runner.mjs",
    )
    .map_err(|e| {
        format!("could not locate the runner bundle ({e}). Reinstall: npm install -g baro-ai")
    })?;

    let mut cmd = match &entry {
        discovery::ScriptEntry::Tsx { tsx, script } => {
            let mut c = tokio::process::Command::new(tsx);
            c.arg(script);
            c
        }
        discovery::ScriptEntry::NodeJs(js) => {
            let mut c = tokio::process::Command::new("node");
            c.arg(js);
            c
        }
    };
    if let Some(t) = &token {
        cmd.env("RUNNER_TOKEN", t);
    }
    if let Some(u) = &control_url {
        cmd.env("CONTROL_URL", u);
    }
    cmd.env("WORKSPACE_DIR", &cwd);
    if once {
        cmd.env("BARO_RUN_ONCE", "1");
    }
    if service {
        cmd.env("BARO_SERVICE", "1");
    }
    if no_service_prompt {
        cmd.env("BARO_NO_SERVICE_PROMPT", "1");
    }
    // The runner spawns `baro --headless`; point it at this very binary.
    if let Ok(exe) = std::env::current_exe() {
        cmd.env("BARO_BIN", exe);
    }
    // stdin stays attached (inherit): the runner asks its one-time
    // "keep this runner online?" question on a TTY. It reads nothing else.

    println!(
        "baro connect — starting runner (workspace: {})",
        cwd.display()
    );
    let status = cmd
        .spawn()
        .map_err(|e| format!("failed to start runner: {e}"))?
        .wait()
        .await?;
    std::process::exit(status.code().unwrap_or(1));
}

async fn run_app(
    mut terminal: Option<&mut Terminal<CrosstermBackend<Box<dyn Write>>>>,
    cli: cli::cli::Cli,
) -> Result<(), Box<dyn std::error::Error>> {
    let headless = cli.headless;
    let critic_explicitly_requested = cli.with_critic;
    let critic_backend_explicitly_set = cli.critic_llm.is_some();
    let mut app = App::new();
    let cwd = std::fs::canonicalize(&cli.cwd)?;

    let rc = config::load_config(&cwd);

    app.parallel_limit = resolve_parallel_limit(rc.parallel, cli.parallel);
    // 0 = "auto": the orchestrator effort-scales the per-story timeout.
    app.timeout_secs = rc.timeout.unwrap_or(0);

    app.planner = match rc.planner.as_deref() {
        Some("openai") => Planner::OpenAI,
        Some("codex") => Planner::Codex,
        Some("opencode") => Planner::OpenCode,
        Some("pi") => Planner::Pi,
        _ => Planner::Claude,
    };

    match rc.model.as_deref() {
        Some("opus") | Some("sonnet") | Some("haiku") => {
            app.override_model = rc.model.clone();
            app.model_routing = false;
        }
        _ => {} // "routed" or None = keep defaults
    }

    if let Some(t) = cli.timeout {
        app.timeout_secs = t;
    }

    if cli.planner != "claude" {
        app.planner = match cli.planner.as_str() {
            "openai" => Planner::OpenAI,
            "codex" => Planner::Codex,
            "opencode" => Planner::OpenCode,
            "pi" => Planner::Pi,
            _ => Planner::Claude,
        };
    }

    // When --llm is set, auto-select the matching planner so the user
    // doesn't need to pass both --llm and --planner.
    match cli.llm.as_str() {
        "openai" => app.planner = Planner::OpenAI,
        "codex" => app.planner = Planner::Codex,
        "opencode" => app.planner = Planner::OpenCode,
        "pi" => app.planner = Planner::Pi,
        _ => {} // claude/hybrid keep the default or explicit --planner
    }

    if let Some(ref model) = cli.model {
        // Accepted verbatim so non-Claude backends can name any
        // provider/model string; the Claude-only opus/sonnet/haiku
        // vocabulary is validated after per-phase backends are
        // resolved (see the check below).
        app.override_model = Some(model.clone());
        app.model_routing = false;
    } else if cli.no_model_routing {
        app.override_model = Some("opus".to_string());
        app.model_routing = false;
    }

    // Critic + Surgeon (LLM) default ON; the hidden legacy --with-*
    // flags are still accepted, --no-* opts out.
    if cli.no_critic {
        app.with_critic = false;
    } else {
        app.with_critic = true;
    }
    if let Some(ref m) = cli.critic_model {
        app.critic_model = Some(m.clone());
    }
    if cli.no_librarian {
        app.with_librarian = false;
    }
    if cli.no_memory {
        app.with_memory = false;
    }
    if cli.no_sentry {
        app.with_sentry = false;
    }
    if cli.no_surgeon {
        app.with_surgeon = false;
    } else {
        app.with_surgeon = true;
    }
    if cli.no_surgeon_llm {
        app.surgeon_use_llm = false;
    } else {
        app.surgeon_use_llm = true;
    }
    if let Some(ref m) = cli.surgeon_model {
        app.surgeon_model = Some(m.clone());
    }
    if let Some(ref m) = cli.architect_model {
        app.architect_model = Some(m.clone());
    }
    if let Some(ref m) = cli.planner_model {
        app.planner_model = Some(m.clone());
    }
    if let Some(ref m) = cli.story_model {
        app.story_model = Some(m.clone());
    }
    if let Some(ref tm) = cli.tier_map {
        app.tier_map = Some(tm.clone());
    }
    if !cli.openai_endpoint.is_empty() {
        app.openai_endpoints = cli.openai_endpoint.clone();
    }
    if let Some(d) = cli.intra_level_delay {
        app.intra_level_delay_secs = Some(d);
    }

    // --quick silences Critic + Surgeon — their value is coordinating
    // parallel work a single-story run doesn't have. Librarian + Sentry
    // stay on (cheap, harmless).
    if cli.quick {
        app.quick = true;
        app.with_critic = false;
        app.with_surgeon = false;
    }

    app.effort = cli.effort.clone();
    app.mode = cli.mode.clone();
    app.confirm_mode = cli.confirm_mode;

    // `cli.llm` defaults to "claude", so its value alone can't distinguish
    // an explicit `--llm claude` / `--llm hybrid` from the no-flag default;
    // the provider picker needs that distinction, so scan the raw argv.
    app.llm_explicitly_set = std::env::args().any(|a| a == "--llm" || a.starts_with("--llm="));

    match cli.llm.as_str() {
        "hybrid" => {
            // The preset only sets the defaults — explicit per-phase
            // flags below win over these.
            app.llm = app::LlmProvider::Claude; // bookkeeping default
            app.architect_llm = app::LlmProvider::Claude;
            app.planner_llm = app::LlmProvider::Claude;
            app.story_llm = app::LlmProvider::Codex;
            // Codex CLI has no tool-less inference mode, so it cannot safely
            // inspect untrusted repository evidence as a Critic. Keep review
            // on Claude while Codex executes stories.
            app.critic_llm = app::LlmProvider::Claude;
            app.surgeon_llm = app::LlmProvider::Claude;
        }
        "jigjoy" => {
            // Hosted preset: every phase talks to the baro gateway, an
            // OpenAI-compatible proxy that holds the upstream keys and
            // maps model names to tiers. Planning/replanning defaults to GLM,
            // while high-blast-radius execution and review use DeepSeek Pro.
            // Every lane remains independently env-overridable.
            app.llm = app::LlmProvider::OpenAI;
            app.architect_llm = app::LlmProvider::OpenAI;
            app.planner_llm = app::LlmProvider::OpenAI;
            app.story_llm = app::LlmProvider::OpenAI;
            app.critic_llm = app::LlmProvider::OpenAI;
            app.surgeon_llm = app::LlmProvider::OpenAI;

            // Per-phase defaults only when the user didn't pin a model.
            // These are the gateway's tier tokens; env-overridable so a
            // self-hosted gateway can point them at its own models.
            //
            // Three lanes, deliberately separate:
            //  - Planner lane (planner + architect + surgeon) = `strong` model.
            //    Planning quality is what scales with the subscription tier, so
            //    this is where GLM earns its cost.
            //  - Executor lane = Flash for light/standard work, DeepSeek Pro for
            //    `heavy` stories whose failure can break shared contracts.
            //  - Review lane = DeepSeek Pro. A cheap Critic that misses semantic
            //    defects makes the entire collective look green incorrectly.
            let strong = std::env::var("BARO_JIGJOY_STRONG_MODEL")
                .unwrap_or_else(|_| JIGJOY_STRONG_MODEL.to_string());
            let cheap = std::env::var("BARO_JIGJOY_STORY_MODEL")
                .unwrap_or_else(|_| JIGJOY_CHEAP_STORY_MODEL.to_string());
            let story_heavy = std::env::var("BARO_JIGJOY_STORY_HEAVY_MODEL")
                .unwrap_or_else(|_| JIGJOY_HEAVY_STORY_MODEL.to_string());
            let surgeon =
                std::env::var("BARO_JIGJOY_SURGEON_MODEL").unwrap_or_else(|_| strong.clone());
            let critic =
                std::env::var("BARO_JIGJOY_CRITIC_MODEL").unwrap_or_else(|_| story_heavy.clone());
            if app.planner_model.is_none() {
                app.planner_model = Some(strong.clone());
            }
            if app.architect_model.is_none() {
                app.architect_model = Some(strong.clone());
            }
            if app.surgeon_model.is_none() {
                app.surgeon_model = Some(surgeon.clone());
            }
            if app.critic_model.is_none() {
                app.critic_model = Some(critic);
            }
            // Most story tiers map to the cheap model; `heavy` maps to the
            // executor lane (story_heavy) for focused/high-blast-radius work
            // selected by the Intake + Planner contract — NOT the planner's
            // frontier model. Routing accepts the legacy haiku/sonnet/opus
            // spellings as aliases, so old PRDs still hit these keys.
            if app.tier_map.is_none() {
                app.tier_map = Some(format!(
                    "default=openai:{cheap},light=openai:{cheap},standard=openai:{cheap},heavy=openai:{story_heavy}"
                ));
            }

            let explicit_url = cli
                .openai_base_url
                .clone()
                .filter(|value| !value.is_empty());
            let jigjoy_url = std::env::var("BARO_JIGJOY_URL")
                .ok()
                .filter(|value| !value.is_empty());
            let custom_gateway = explicit_url.is_some() || jigjoy_url.is_some();
            let jigjoy_key = std::env::var("JIGJOY_API_KEY")
                .ok()
                .filter(|value| !value.is_empty());
            let ambient_openai_key = std::env::var("OPENAI_API_KEY")
                .ok()
                .filter(|value| !value.is_empty());
            // At the hosted default, only a recognizable signed Gateway key
            // is a safe compatibility fallback. A normal sk-* OpenAI key is
            // unrelated and must never be sent to JigJoy. Custom/self-hosted
            // endpoints retain the historical arbitrary-key fallback.
            let compatible_openai_key = ambient_openai_key
                .filter(|key| custom_gateway || is_signed_jigjoy_gateway_key(key));
            let manual_key = preferred_jigjoy_gateway_key(jigjoy_key, compatible_openai_key);

            // No manual key at the official endpoint: exchange the local
            // `baro login` for one server-generated run identity and a
            // short-lived scoped credential. Never auto-send a login bearer
            // to a caller-selected compatible endpoint.
            let issued = if manual_key.is_none() && !custom_gateway {
                Some(gateway_credential::acquire(&cwd).await.map_err(|error| {
                    format!("could not acquire local JigJoy credential: {error}")
                })?)
            } else {
                None
            };
            if manual_key.is_none() && issued.is_none() {
                return Err(
                    "a custom JigJoy/OpenAI endpoint requires an explicit JIGJOY_API_KEY".into(),
                );
            }

            // A JigJoy run must not inherit an unrelated ambient
            // OPENAI_BASE_URL. An auto-issued credential uses only the
            // authenticated control plane's returned Gateway URL.
            let url = issued
                .as_ref()
                .map(|credential| credential.gateway_base_url.clone())
                .unwrap_or_else(|| preferred_jigjoy_gateway_url(explicit_url, jigjoy_url));
            std::env::set_var("OPENAI_BASE_URL", &url);
            // Only the explicit JigJoy preset grants billing authority to the
            // same endpoint. Generic OPENAI_BASE_URL values remain untrusted.
            std::env::set_var("BARO_GATEWAY_BILLING_URL", &url);
            // Marks ownership of the injected routing variables even when a
            // credential is missing. Subscription-backed harness children
            // use this to remove only Baro-owned Gateway environment.
            std::env::set_var("BARO_JIGJOY_ENV_INJECTED", "1");

            let key = issued
                .as_ref()
                .map(|credential| credential.api_key.clone())
                .or(manual_key)
                .expect("JigJoy credential checked above");
            // Inference correlation is credential-bound. Keep the model
            // request and receipt-feed credentials byte-identical even if
            // the parent shell contains a stale billing-specific value.
            std::env::set_var("OPENAI_API_KEY", &key);
            std::env::set_var("BARO_GATEWAY_BILLING_API_KEY", &key);

            if std::env::var("BARO_RUN_ID").is_err() {
                let run_id = issued
                    .as_ref()
                    .map(|credential| credential.run_id.clone())
                    .or_else(|| legacy_hosted_run_id(&key).map(str::to_string))
                    .unwrap_or_else(local_client_run_id);
                std::env::set_var("BARO_RUN_ID", run_id);
            }
        }
        other => {
            if let Some(provider) = app::LlmProvider::parse(other) {
                app.llm = provider;
                app.architect_llm = provider;
                app.planner_llm = provider;
                app.story_llm = provider;
                app.critic_llm = provider;
                app.surgeon_llm = provider;
            }
        }
    }

    // Per-phase CLI overrides win over the preset / global default.
    if let Some(ref v) = cli.architect_llm {
        if let Some(p) = app::LlmProvider::parse(v) {
            app.architect_llm = p;
        }
    }
    if let Some(ref v) = cli.planner_llm {
        if let Some(p) = app::LlmProvider::parse(v) {
            app.planner_llm = p;
        }
    }
    if let Some(ref v) = cli.story_llm {
        if let Some(p) = app::LlmProvider::parse(v) {
            app.story_llm = p;
        }
    }
    if let Some(ref v) = cli.critic_llm {
        if let Some(p) = app::LlmProvider::parse(v) {
            app.critic_llm = p;
        }
    }
    if let Some(ref v) = cli.surgeon_llm {
        if let Some(p) = app::LlmProvider::parse(v) {
            app.surgeon_llm = p;
        }
    }

    if cli.llm == "jigjoy" {
        reconcile_jigjoy_phase_overrides(
            &mut app,
            cli.architect_model.is_some(),
            cli.planner_model.is_some(),
            cli.critic_model.is_some(),
            cli.surgeon_model.is_some(),
            cli.tier_map.is_some(),
        );
    }

    if disable_implicit_codex_critic(
        &mut app,
        critic_explicitly_requested,
        critic_backend_explicitly_set,
    ) {
        eprintln!("[baro] WARNING: {CODEX_CRITIC_AUTO_DISABLED_WARNING}");
    }

    if let Some(message) = unsupported_critic_backend(app.with_critic, app.critic_llm) {
        eprintln!("[baro] error: {}", message);
        std::process::exit(2);
    }

    // A global `--model` hits EVERY phase, but the Claude CLI only
    // accepts opus/sonnet/haiku — reject early if any phase still
    // routes through Claude. The check lives here, after per-phase
    // resolution, because only now do we know which phases those are.
    if let Some(ref model) = cli.model {
        let is_claude_model = matches!(model.as_str(), "opus" | "sonnet" | "haiku");
        let any_claude_phase = [
            app.architect_llm,
            app.planner_llm,
            app.story_llm,
            app.critic_llm,
            app.surgeon_llm,
        ]
        .iter()
        .any(|p| *p == app::LlmProvider::Claude);
        if !is_claude_model && any_claude_phase {
            eprintln!(
                "[baro] error: --model '{}' is not a Claude model (opus/sonnet/haiku) \
                 but at least one phase still runs on Claude. `--model` applies to \
                 every phase, so it must be Claude-compatible unless all phases use a \
                 non-Claude backend. Route the Claude phases elsewhere (e.g. \
                 `--llm opencode`) or use a per-phase model flag.",
                model
            );
            std::process::exit(2);
        }
    }

    if app.llm == app::LlmProvider::OpenAI && std::env::var("OPENAI_API_KEY").is_err() {
        eprintln!(
            "[baro] WARNING: --llm openai requested but OPENAI_API_KEY is not set. \
             Interactive mode will request it before the first turn; \
             --headless requires it in the environment."
        );
    }

    let (tx, mut rx) = mpsc::channel::<AppEvent>(256);
    let mut next_refine_generation = 0_u64;
    let mut active_refine_generation: Option<u64> = None;

    // Resume detection: the PRD in the initial checkout supplies only the
    // branch hint. Establish that branch and reload its own PRD before showing
    // Review, otherwise refinement could inspect one branch while executing
    // and overwriting another.
    let prd_path = cwd.join("prd.json");
    if cli.continue_run {
        let prd_branch_hint = std::fs::read_to_string(&prd_path)
            .ok()
            .and_then(|contents| serde_json::from_str::<executor::PrdFile>(&contents).ok())
            .map(|prd| prd.branch_name);
        let current_branch = git::get_current_branch(&cwd)
            .await
            .map_err(|error| format!("cannot establish --continue branch authority: {error}"))?;
        let continuation_branch = branch_authority::verify_continuation_branch(
            &current_branch,
            prd_branch_hint.as_deref(),
        )
        .map_err(|error| format!("cannot establish --continue branch authority: {error}"))?;
        app.is_followup = true;
        app.branch_name = continuation_branch.clone();
        app.continuation_branch = Some(continuation_branch);
        // The JS orchestrator uses this only after Rust has verified and kept
        // the existing branch; the environment flag is not branch authority.
        std::env::set_var("BARO_CONTINUE", "1");
    }
    let mut entered_resume = false;
    if prd_path.exists() {
        let initial = std::fs::read_to_string(&prd_path)
            .map_err(|error| error.to_string())
            .and_then(|contents| {
                serde_json::from_str::<executor::PrdFile>(&contents)
                    .map_err(|error| error.to_string())
            });
        match initial {
            Ok(branch_hint) => {
                let has_incomplete = branch_hint.user_stories.iter().any(|story| !story.passes);
                if cli.resume || (has_incomplete && cli.goal.is_none()) {
                    let prd = resume::checkout_and_load_prd(&cwd, &branch_hint.branch_name)
                        .await
                        .map_err(|error| format!("cannot establish resume branch: {error}"))?;
                    let current_branch = git::get_current_branch(&cwd)
                        .await
                        .map_err(|error| format!("cannot verify resume branch: {error}"))?;
                    let continuation_branch = branch_authority::verify_continuation_branch(
                        &current_branch,
                        Some(&prd.branch_name),
                    )
                    .map_err(|error| format!("cannot verify resume branch: {error}"))?;
                    app.is_resume = true;
                    app.project = prd.project.clone();
                    app.branch_name = continuation_branch.clone();
                    app.continuation_branch = Some(continuation_branch);
                    app.description = prd.description.clone();
                    app.decision_document = prd.decision_document.clone();
                    app.execution_mode = prd.execution_mode.clone();
                    restore_conversation_from_prd(&mut app, &prd, &cwd);
                    let stories = review_stories_from_prd(&prd);
                    app.show_review(stories);
                    entered_resume = true;
                }
            }
            Err(error) if cli.resume => {
                return Err(format!("cannot resume from prd.json: {error}").into());
            }
            Err(_) => {}
        }
    }

    // Pre-fill OpenAI key/base URL from env BEFORE the goal branching —
    // a CLI-goal run skips the ApiKeyInput screen, so this is its only
    // chance to pick up OPENAI_API_KEY.
    if let Ok(env_key) = std::env::var("OPENAI_API_KEY") {
        if !env_key.is_empty() {
            app.openai_api_key = Some(env_key);
        }
    }
    // --openai-base-url flag wins over the env var when both are set.
    if let Some(ref url) = cli.openai_base_url {
        app.openai_base_url = Some(url.clone());
    } else if let Ok(env_url) = std::env::var("OPENAI_BASE_URL") {
        if !env_url.is_empty() {
            app.openai_base_url = Some(env_url);
        }
    }

    // An explicit new goal wins over an unfinished local intake. Interactive
    // startup without one resumes the repository-scoped clarification or
    // closes an interrupted provider turn so the user can retry safely.
    if !entered_resume && cli.goal.is_none() {
        restore_pre_prd_conversation(&mut app, &cwd);
    }

    // Every new goal is now the first user turn of the durable conversation
    // session. Provider selection may precede it because the front-door agent
    // needs a backend; planning never starts until a validated GoalEnvelope is
    // handed off exactly once.
    if !entered_resume {
        if let Some(goal) = cli.goal {
            app.conversation_input = goal;
            if app.llm == app::LlmProvider::OpenAI && app.openai_api_key.is_none() {
                if headless {
                    return Err("--headless with --llm openai requires OPENAI_API_KEY".into());
                }
                app.screen = app::Screen::ApiKeyInput;
                app.api_key_input.clear();
            } else {
                let message = std::mem::take(&mut app.conversation_input);
                submit_conversation_message(&mut app, &cwd, tx.clone(), message)
                    .map_err(|error| format!("cannot start conversation: {error}"))?;
            }
        } else {
            if headless {
                return Err("--headless requires a goal argument".into());
            }
            // Gate on whether --llm was actually passed, NOT on
            // `llm != Claude`: hybrid and explicit `--llm claude` both
            // resolve to Claude, and re-prompting would let the picker
            // overwrite the hybrid per-phase split.
            if app.llm_explicitly_set {
                app.start_conversation();
            } else {
                app.screen = app::Screen::ProviderPicker;
            }
        }
    }

    // Keyboard input from /dev/tty (TUI only — headless has no terminal).
    if !headless {
        let tx_key = tx.clone();
        std::thread::spawn(move || loop {
            match crossterm::event::poll(Duration::from_millis(100)) {
                Ok(true) => {
                    if let Ok(crossterm::event::Event::Key(key)) = crossterm::event::read() {
                        if tx_key.blocking_send(AppEvent::Key(key)).is_err() {
                            break;
                        }
                    }
                }
                Ok(false) => {}
                Err(_) => break,
            }
        });
    }

    let tx_tick = tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if tx_tick.send(AppEvent::Tick).await.is_err() {
                break;
            }
        }
    });

    // Throttle drawing to ~30fps: the orchestrator floods the channel with
    // log events, and drawing per event pegs the CPU and starves keyboard
    // input. Events still apply immediately; the 100ms tick guarantees an
    // idle refresh so the final frame after a burst is at most a tick late.
    let mut last_draw = Instant::now()
        .checked_sub(Duration::from_millis(100))
        .unwrap_or_else(Instant::now);
    loop {
        if let Some(t) = terminal.as_deref_mut() {
            if last_draw.elapsed() >= Duration::from_millis(33) {
                t.draw(|f| ui::render(f, &mut app))?;
                last_draw = Instant::now();
            }
        }
        match rx.recv().await {
            Some(AppEvent::Baro(ev)) => {
                if matches!(ev, BaroEvent::NotificationReady) {
                    notification::notify_completion();
                }
                let is_done = matches!(ev, BaroEvent::Done { .. });
                let is_exit = matches!(ev, BaroEvent::OrchestratorExited { .. });
                let is_runtime_conversation = matches!(
                    ev,
                    BaroEvent::ConversationRequest { .. }
                        | BaroEvent::ConversationResponse { .. }
                        | BaroEvent::ConversationFailed { .. }
                );
                let story_start_id = if let BaroEvent::StoryStart { ref id, .. } = ev {
                    Some(id.clone())
                } else {
                    None
                };
                app.handle_event(ev);
                if is_runtime_conversation {
                    persist_conversation(&app.conversation, &cwd);
                }
                if is_done || is_exit {
                    finish_conversation_run(&mut app, is_done, &cwd);
                }
                // Headless: events already stream to stdout via echo_raw;
                // orchestrator exit means the run is done.
                if headless {
                    if is_exit {
                        break;
                    }
                    continue;
                }
                if story_start_id.is_some() {
                    app.auto_scroll_to_running();
                }
                if let Some(ref sid) = story_start_id {
                    if app.main_view == app::MainView::Plan {
                        if let Some(t) = terminal.as_deref_mut() {
                            let visible =
                                t.size().map(|s| s.height.saturating_sub(10)).unwrap_or(20);
                            app.dag_auto_scroll_to_story(sid, visible);
                        }
                    }
                }
            }
            Some(AppEvent::ConversationResponse(response)) => {
                if response.kind == ConversationKind::Ready
                    && !app.quick
                    && supports_preaccept_architect_outcome(app.architect_llm)
                {
                    let failed_request_id = response.request_id.clone();
                    if let Err(error) = spawn_conversation_architect_validation(
                        &mut app,
                        &cwd,
                        tx.clone(),
                        response,
                        headless,
                    ) {
                        let close_result = close_failed_initial_request(
                            &mut app,
                            &failed_request_id,
                            "Repository validation could not start; retry the request.",
                        );
                        persist_conversation(&app.conversation, &cwd);
                        match &close_result {
                            Ok(false) => continue,
                            Ok(true) => app.conversation_busy = false,
                            Err(_) => {}
                        }
                        let error = match close_result {
                            Err(close_error) => format!("{error}; {close_error}"),
                            Ok(_) => error,
                        };
                        if headless {
                            return Err(format!("goal validation failed: {error}").into());
                        }
                        app.conversation_error = Some(error);
                        app.screen = Screen::Conversation;
                    }
                    continue;
                }
                if let Err(error) = accept_conversation_response(
                    &mut app,
                    &cwd,
                    tx.clone(),
                    response,
                    headless,
                    None,
                )
                .await
                {
                    if headless {
                        return Err(error.into());
                    }
                    app.conversation_error = Some(error);
                    app.screen = Screen::Conversation;
                }
            }
            Some(AppEvent::ConversationArchitectOutcome {
                candidate,
                repository_context,
                transport,
            }) => match transport.outcome.kind {
                architect_runner::ArchitectOutcomeKindV1::Ready => {
                    let decision_document = transport
                        .outcome
                        .decision_document
                        .ok_or("validated Architect outcome has no decision document")?;
                    if let Err(error) = accept_conversation_response(
                        &mut app,
                        &cwd,
                        tx.clone(),
                        candidate,
                        headless,
                        Some(PrevalidatedArchitect {
                            repository_context,
                            decision_document,
                        }),
                    )
                    .await
                    {
                        if headless {
                            return Err(error.into());
                        }
                        app.conversation_error = Some(error);
                        app.screen = Screen::Conversation;
                    }
                }
                architect_runner::ArchitectOutcomeKindV1::NeedsInput => {
                    app.architect_status = app::ArchitectStatus::Skipped(
                        "Waiting for repository-specific clarification.".to_string(),
                    );
                    app.planning_progress = None;
                    let clarification = match architect_clarification_response(
                        &candidate,
                        transport.outcome,
                    ) {
                        Ok(clarification) => clarification,
                        Err(error) => {
                            let close_result = close_failed_initial_request(
                                &mut app,
                                &candidate.request_id,
                                "Repository validation returned an invalid clarification; retry the request.",
                            );
                            persist_conversation(&app.conversation, &cwd);
                            match &close_result {
                                Ok(false) => continue,
                                Ok(true) => app.conversation_busy = false,
                                Err(_) => {}
                            }
                            let error = match close_result {
                                Err(close_error) => format!("{error}; {close_error}"),
                                Ok(_) => error,
                            };
                            if headless {
                                return Err(
                                    format!("invalid Architect clarification: {error}").into()
                                );
                            }
                            app.conversation_error =
                                Some(format!("Invalid Architect clarification: {error}"));
                            app.screen = Screen::Conversation;
                            continue;
                        }
                    };
                    if let Err(error) = accept_conversation_response(
                        &mut app,
                        &cwd,
                        tx.clone(),
                        clarification,
                        headless,
                        None,
                    )
                    .await
                    {
                        if headless {
                            return Err(error.into());
                        }
                        app.conversation_error = Some(error);
                        app.screen = Screen::Conversation;
                    }
                }
            },
            Some(AppEvent::ConversationError {
                request_id,
                error,
                log_path,
            }) => {
                let architect_failure = app.architect_status == app::ArchitectStatus::Running;
                let deterministic_reason = if architect_failure {
                    "Repository validation failed before the goal was accepted; retry the request."
                } else {
                    "The conversation backend failed before returning a response; retry the request."
                };
                let close_result =
                    close_failed_initial_request(&mut app, &request_id, deterministic_reason);
                persist_conversation(&app.conversation, &cwd);
                match &close_result {
                    Ok(false) => {
                        // A late failure for an already completed request
                        // cannot unlock or overwrite a newer in-flight turn.
                        continue;
                    }
                    Ok(true) => app.conversation_busy = false,
                    Err(_) => {}
                }
                if architect_failure {
                    app.architect_status =
                        app::ArchitectStatus::Skipped("Validation failed.".to_string());
                }
                let error = match close_result {
                    Err(close_error) => format!("{error}; {close_error}"),
                    Ok(_) => error,
                };
                if headless {
                    return Err(format!("conversation failed: {error}").into());
                }
                app.conversation_error = Some(match log_path {
                    Some(path) => format!("{error} (log: {})", path.display()),
                    None => error,
                });
                app.screen = Screen::Conversation;
            }
            Some(AppEvent::ContextReady(content)) => {
                app.claude_md_content = Some(content);
                app.start_planning();
                spawn_planner(&app, &cwd, tx.clone(), headless, None);
            }
            Some(AppEvent::ContextError(err)) => {
                let conversation_owned = app.conversation.goal_envelope().is_some();
                fail_conversation_run(&mut app, &format!("context discovery failed: {err}"), &cwd);
                if headless {
                    return Err(format!("context build failed: {}", err).into());
                }
                app.planning_error = Some(err.clone());
                if conversation_owned {
                    app.conversation_error = Some(format!(
                        "Repository context discovery failed: {err}. Tell me to retry or adjust the goal."
                    ));
                    app.screen = Screen::Conversation;
                }
            }
            Some(AppEvent::ProgressivePlanningPrepared(spec)) => {
                if let Err(error) =
                    begin_progressive_execution(&mut app, spec, &cwd, tx.clone()).await
                {
                    if headless {
                        return Err(format!("progressive planning could not start: {error}").into());
                    }
                    app.planning_error = Some(error);
                    app.screen = Screen::Conversation;
                }
            }
            Some(AppEvent::PlannerFinished(outcome)) => match outcome {
                PlannerOutcome::Ready {
                    stories,
                    project,
                    branch,
                    description,
                    execution_mode,
                    progressive: false,
                } => {
                    app.project = project;
                    app.branch_name = branch;
                    app.description = description;
                    app.execution_mode = execution_mode;
                    if headless {
                        // Emit a planning event for the runner/dashboard, then
                        // auto-confirm and execute (no review screen).
                        println!(r#"{{"type":"plan_ready","stories":{}}}"#, stories.len());
                        confirm_and_execute(&mut app, stories, &cwd, tx.clone());
                    } else {
                        app.show_review(stories);
                    }
                }
                PlannerOutcome::Ready {
                    stories,
                    project,
                    branch,
                    description,
                    execution_mode,
                    progressive: true,
                } => {
                    app.project = project;
                    app.branch_name = branch;
                    app.description = description;
                    app.execution_mode = execution_mode;
                    println!(
                        r#"{{"type":"plan_ready","stories":{},"progressive":true}}"#,
                        stories.len()
                    );
                    app.review_stories = stories;
                }
                PlannerOutcome::Failed {
                    message,
                    log_path,
                    progressive: true,
                } => {
                    // The host attempted a backpressured correlated
                    // plan_failed before publishing this outcome. A closed
                    // command lane is included in the message below.
                    eprintln!("[baro] progressive planner failed: {message}");
                    app.planning_error = Some(message);
                    app.planning_log_path = log_path;
                }
                PlannerOutcome::Failed {
                    message,
                    log_path,
                    progressive: false,
                } => {
                    let conversation_owned = app.conversation.goal_envelope().is_some();
                    fail_conversation_run(&mut app, &format!("planning failed: {message}"), &cwd);
                    if headless {
                        return Err(format!("planning failed: {message}").into());
                    }
                    app.planning_error = Some(message.clone());
                    app.planning_log_path = log_path;
                    if conversation_owned {
                        app.conversation_error = Some(format!(
                            "Planning failed: {message}. Tell me to retry or adjust the goal."
                        ));
                        app.screen = Screen::Conversation;
                    }
                }
            },
            Some(AppEvent::IntakeReady {
                decision_doc,
                contract_json,
            }) => {
                if app.decision_document.is_none() {
                    app.decision_document = decision_doc;
                }
                // Unparseable contracts collapse to the Rust fallback so the
                // picker always has something coherent to propose.
                let (view, json) = match serde_json::from_str::<ModeContractView>(&contract_json) {
                    Ok(v) => (v, contract_json),
                    Err(_) => (
                        serde_json::from_str::<ModeContractView>(intake_runner::FALLBACK_CONTRACT)
                            .expect("fallback contract is valid"),
                        intake_runner::FALLBACK_CONTRACT.to_string(),
                    ),
                };
                app.mode_picker_index = app::MODE_OPTIONS
                    .iter()
                    .position(|m| *m == view.mode)
                    .unwrap_or(0);
                app.mode_proposal = Some(app::ModeProposal {
                    mode: view.mode,
                    reason: view.reason,
                    confidence: view.confidence,
                    contract_json: json,
                });
                app.screen = Screen::ModePicker;
            }
            Some(AppEvent::RefineReady(
                generation,
                mut stories,
                project,
                branch,
                description,
                execution_mode,
            )) => {
                if !resume::should_accept_refine_result(
                    app.screen,
                    app.refining,
                    active_refine_generation,
                    generation,
                ) {
                    continue;
                }
                active_refine_generation = None;
                app.refining = false;
                if app.is_resume {
                    stories = review_refiner::preserve_completed_review_stories(
                        &app.review_stories,
                        stories,
                    );
                }
                app.project = project;
                if !app.is_resume {
                    app.branch_name = branch;
                    app.execution_mode = execution_mode;
                }
                app.description = description;
                app.show_review(stories);
            }
            Some(AppEvent::RefineError(generation, err)) => {
                if !resume::should_accept_refine_result(
                    app.screen,
                    app.refining,
                    active_refine_generation,
                    generation,
                ) {
                    continue;
                }
                active_refine_generation = None;
                app.refining = false;
                app.planning_error = Some(err);
            }
            Some(AppEvent::PlanProgress(msg)) => {
                // Headless prints its own story_log line from the runner
                // callback; here we only feed the TUI planning screen.
                app.planning_progress = Some(msg);
            }
            Some(AppEvent::ArchitectStarted) => {
                if headless {
                    println!(r#"{{"type":"architect_start"}}"#);
                }
                app.architect_status = app::ArchitectStatus::Running;
            }
            Some(AppEvent::ArchitectComplete(doc)) => {
                if headless {
                    println!(r#"{{"type":"architect_complete"}}"#);
                }
                app.architect_status = app::ArchitectStatus::Complete;
                app.decision_document = Some(doc);
            }
            Some(AppEvent::ArchitectSkipped(reason)) => {
                if headless {
                    println!(
                        "{}",
                        serde_json::json!({
                            "type": "architect_skipped",
                            "reason": &reason,
                        })
                    );
                }
                app.architect_status = app::ArchitectStatus::Skipped(reason);
                app.decision_document = None;
            }
            Some(AppEvent::BranchError(err)) => {
                let conversation_owned = app.conversation.goal_envelope().is_some();
                fail_conversation_run(&mut app, &err, &cwd);
                if headless {
                    return Err(format!("branch/exec failed: {}", err).into());
                }
                app.planning_error = Some(err.clone());
                if conversation_owned {
                    app.conversation_error = Some(format!(
                        "Execution could not start: {err}. Tell me to retry or change the goal."
                    ));
                    app.screen = Screen::Conversation;
                } else {
                    app.screen = Screen::Review;
                }
            }
            Some(AppEvent::BranchReady(name)) => {
                app.branch_name = name.clone();
                app.continuation_branch = Some(name);
            }
            Some(AppEvent::Key(key)) => {
                // Keys only arrive in TUI mode; rebind `terminal` to the
                // real handle so the screen handlers below are unchanged.
                let Some(terminal) = terminal.as_deref_mut() else {
                    continue;
                };
                use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};
                // Kitty-protocol terminals (Ghostty) emit Enter as a
                // Release-only event or literal CR/LF Char, which a
                // Press-only filter would swallow. Let Enter-like events
                // through any kind; the rest still require Press so we
                // don't double-fire on Release.
                let is_enter_like = matches!(
                    key.code,
                    KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n')
                );
                if key.kind != KeyEventKind::Press && !is_enter_like {
                    continue;
                }

                // Clear dock badge when user returns to the terminal after a notification
                if app.notification_ready {
                    notification::clear_badge();
                }

                match app.screen {
                    Screen::ProviderPicker => match key.code {
                        KeyCode::Esc | KeyCode::Char('q') => return Ok(()),
                        KeyCode::Up | KeyCode::Char('k') => {
                            if app.provider_picker_index > 0 {
                                app.provider_picker_index -= 1;
                            } else {
                                app.provider_picker_index =
                                    app.provider_picker_options.len().saturating_sub(1);
                            }
                        }
                        KeyCode::Down | KeyCode::Char('j') => {
                            if app.provider_picker_index
                                < app.provider_picker_options.len().saturating_sub(1)
                            {
                                app.provider_picker_index += 1;
                            } else {
                                app.provider_picker_index = 0;
                            }
                        }
                        KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                            let chosen = app.provider_picker_options[app.provider_picker_index];
                            apply_primary_provider_choice(
                                &mut app,
                                chosen,
                                critic_backend_explicitly_set,
                            );
                            if disable_implicit_codex_critic(
                                &mut app,
                                critic_explicitly_requested,
                                critic_backend_explicitly_set,
                            ) {
                                eprintln!("[baro] WARNING: {CODEX_CRITIC_AUTO_DISABLED_WARNING}");
                            }
                            if let Some(message) =
                                unsupported_critic_backend(app.with_critic, app.critic_llm)
                            {
                                return Err(message.into());
                            }
                            // OpenAI needs an API key — detour if missing
                            if chosen == app::LlmProvider::OpenAI && app.openai_api_key.is_none() {
                                app.api_key_input.clear();
                                app.screen = Screen::ApiKeyInput;
                            } else {
                                app.start_conversation();
                            }
                        }
                        _ => {}
                    },
                    Screen::ApiKeyInput => match key.code {
                        KeyCode::Esc => {
                            // Back to the picker, not out of the TUI.
                            app.api_key_input.clear();
                            app.screen = Screen::ProviderPicker;
                        }
                        KeyCode::Char('q') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            return Ok(());
                        }
                        KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                            let trimmed = app.api_key_input.trim();
                            if !trimmed.is_empty() {
                                app.openai_api_key = Some(trimmed.to_string());
                                app.api_key_input.clear();
                                if !app.conversation_input.is_empty() {
                                    let message = std::mem::take(&mut app.conversation_input);
                                    if let Err(error) = submit_conversation_message(
                                        &mut app,
                                        &cwd,
                                        tx.clone(),
                                        message,
                                    ) {
                                        app.start_conversation();
                                        app.conversation_error = Some(error);
                                    }
                                } else {
                                    app.start_conversation();
                                }
                            }
                        }
                        KeyCode::Backspace => {
                            app.api_key_input.pop();
                        }
                        KeyCode::Char(c) => {
                            app.api_key_input.push(c);
                        }
                        _ => {}
                    },
                    Screen::Conversation => match key.code {
                        KeyCode::Esc => return Ok(()),
                        KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            app.conversation_input.clear();
                        }
                        KeyCode::Char('r')
                            if app.conversation_error.is_some()
                                && app.conversation.pending_request_id().is_some()
                                && app.conversation_input.is_empty() =>
                        {
                            let intent = conversation_intent(&app);
                            spawn_pending_conversation(&mut app, &cwd, tx.clone(), intent);
                        }
                        KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                            if app.conversation_accepts_input()
                                && !app.conversation_input.trim().is_empty()
                            {
                                let message = std::mem::take(&mut app.conversation_input);
                                if let Err(error) =
                                    submit_conversation_message(&mut app, &cwd, tx.clone(), message)
                                {
                                    app.conversation_error = Some(error);
                                }
                            }
                        }
                        KeyCode::Backspace if !app.conversation_busy => {
                            app.conversation_input.pop();
                        }
                        KeyCode::Char(character) if !app.conversation_busy => {
                            app.conversation_input.push(character);
                        }
                        _ => {}
                    },
                    Screen::ModePicker => match key.code {
                        KeyCode::Esc | KeyCode::Char('q') => return Ok(()),
                        KeyCode::Up | KeyCode::Char('k') => {
                            if app.mode_picker_index > 0 {
                                app.mode_picker_index -= 1;
                            } else {
                                app.mode_picker_index = app::MODE_OPTIONS.len() - 1;
                            }
                        }
                        KeyCode::Down | KeyCode::Char('j') => {
                            app.mode_picker_index =
                                (app.mode_picker_index + 1) % app::MODE_OPTIONS.len();
                        }
                        KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                            let chosen = app::MODE_OPTIONS[app.mode_picker_index];
                            // Confirming the proposal forwards the intake JSON
                            // verbatim; an override becomes a "user" contract.
                            let mode_json = match app.mode_proposal.take() {
                                Some(p) if p.mode == chosen => p.contract_json,
                                _ => user_mode_contract(
                                    chosen,
                                    &format!("User selected {} mode.", chosen),
                                ),
                            };
                            app.start_planning();
                            spawn_planner_stage_b(&app, &cwd, tx.clone(), mode_json);
                        }
                        _ => {}
                    },
                    Screen::Welcome => match key.code {
                        KeyCode::Esc => return Ok(()),
                        KeyCode::Tab => {
                            app.welcome_field = app.welcome_field.next();
                        }
                        KeyCode::BackTab => {
                            app.welcome_field = app.welcome_field.prev();
                        }
                        KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                            if app.welcome_field != app::WelcomeField::Goal {
                                // Enter on non-goal fields = jump to goal
                                app.welcome_field = app::WelcomeField::Goal;
                            } else if !app.goal_input.is_empty() {
                                if let Some(content) = load_project_instructions(&cwd) {
                                    app.claude_md_content = Some(content);
                                    app.start_planning();
                                    spawn_planner(&app, &cwd, tx.clone(), headless, None);
                                } else {
                                    app.start_context();
                                    spawn_context_builder(&cwd, tx.clone());
                                }
                            }
                        }
                        KeyCode::Left | KeyCode::Right => {
                            match app.welcome_field {
                                app::WelcomeField::Model => {
                                    // Cycle: routed -> opus -> sonnet -> haiku
                                    let options: &[Option<&str>] =
                                        &[None, Some("opus"), Some("sonnet"), Some("haiku")];
                                    let current = options
                                        .iter()
                                        .position(|o| match (&app.override_model, o) {
                                            (None, None) => app.model_routing,
                                            (Some(m), Some(o)) => m.as_str() == *o,
                                            _ => false,
                                        })
                                        .unwrap_or(0);
                                    let next = if key.code == KeyCode::Right {
                                        (current + 1) % options.len()
                                    } else {
                                        (current + options.len() - 1) % options.len()
                                    };
                                    if next == 0 {
                                        app.override_model = None;
                                        app.model_routing = true;
                                    } else {
                                        app.override_model = options[next].map(|s| s.to_string());
                                        app.model_routing = false;
                                    }
                                }
                                app::WelcomeField::Parallel => {
                                    if key.code == KeyCode::Right {
                                        app.parallel_limit = app.parallel_limit.saturating_add(1);
                                    } else {
                                        app.parallel_limit = app.parallel_limit.saturating_sub(1);
                                    }
                                }
                                app::WelcomeField::Timeout => {
                                    if key.code == KeyCode::Right {
                                        app.timeout_secs = (app.timeout_secs + 60).min(3600);
                                    } else {
                                        app.timeout_secs =
                                            app.timeout_secs.saturating_sub(60).max(60);
                                    }
                                }
                                app::WelcomeField::Planner => {
                                    app.toggle_planner();
                                }
                                app::WelcomeField::Goal => {} // left/right in text = no-op
                            }
                        }
                        KeyCode::Char(c) => {
                            if app.welcome_field == app::WelcomeField::Goal {
                                // Ctrl+W deletes the previous word, terminal-style.
                                if c == 'w' && key.modifiers.contains(KeyModifiers::CONTROL) {
                                    delete_prev_word(&mut app.goal_input);
                                } else {
                                    app.goal_input.push(c);
                                }
                            }
                        }
                        KeyCode::Backspace => {
                            if app.welcome_field == app::WelcomeField::Goal {
                                app.goal_input.pop();
                            }
                        }
                        _ => {}
                    },
                    Screen::Context => match key.code {
                        KeyCode::Esc | KeyCode::Char('q') => return Ok(()),
                        _ => {}
                    },
                    Screen::Planning => match key.code {
                        KeyCode::Esc | KeyCode::Char('q') => return Ok(()),
                        KeyCode::Char('r') => {
                            if app.planning_error.is_some() {
                                app.planning_error = None;
                                app.start_planning();
                                let validated_document = app.decision_document.clone();
                                spawn_planner(&app, &cwd, tx.clone(), headless, validated_document);
                            }
                        }
                        _ => {}
                    },
                    Screen::Review => {
                        if app.refine_input.is_some() {
                            // Overlay is open — handle overlay keys only
                            match key.code {
                                KeyCode::Esc => {
                                    app.refine_input = None;
                                }
                                KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                                    let feedback = app.refine_input.as_ref().unwrap().clone();
                                    if !feedback.is_empty() {
                                        next_refine_generation =
                                            next_refine_generation.checked_add(1).unwrap_or(1);
                                        active_refine_generation = Some(next_refine_generation);
                                        app.refining = true;
                                        app.refine_input = None;
                                        review_refiner::spawn_refiner(
                                            &app,
                                            next_refine_generation,
                                            &feedback,
                                            &cwd,
                                            tx.clone(),
                                        );
                                    }
                                }
                                KeyCode::Char(c) => {
                                    app.refine_input.as_mut().unwrap().push(c);
                                }
                                KeyCode::Backspace => {
                                    app.refine_input.as_mut().unwrap().pop();
                                }
                                _ => {}
                            }
                        } else if app.planning_error.is_some() {
                            // Branch/planning errors surface as a modal here;
                            // Enter/Esc dismisses rather than re-triggering the
                            // doomed run or quitting.
                            match key.code {
                                KeyCode::Enter
                                | KeyCode::Char('\r')
                                | KeyCode::Char('\n')
                                | KeyCode::Esc => {
                                    app.planning_error = None;
                                }
                                _ => {}
                            }
                        } else {
                            match key.code {
                                KeyCode::Char('r') => {
                                    if !app.refining {
                                        app.refine_input = Some(String::new());
                                    }
                                }
                                KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                                KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n')
                                    if !app.refining =>
                                {
                                    if app.is_resume {
                                        let resume_branch = app.branch_name.clone();
                                        let project = app.project.clone();
                                        let description = app.description.clone();
                                        let reviewed_stories = app.review_stories.clone();
                                        let exec_cwd = cwd.clone();
                                        let branch_tx = tx.clone();
                                        let err_tx = tx.clone();
                                        if let Err(error) =
                                            begin_conversation_execution(&mut app, &cwd)
                                        {
                                            app.planning_error = Some(error);
                                            continue;
                                        }
                                        let cfg = match executor_config_from_app(&app) {
                                            Ok(config) => config,
                                            Err(error) => {
                                                fail_conversation_run(
                                                    &mut app,
                                                    &format!(
                                                        "conversation context projection failed: {error}"
                                                    ),
                                                    &cwd,
                                                );
                                                app.planning_error = Some(error);
                                                continue;
                                            }
                                        };
                                        app.start_execution();
                                        tokio::spawn(async move {
                                            let original_prd = match resume::checkout_and_load_prd(
                                                &exec_cwd,
                                                &resume_branch,
                                            )
                                            .await
                                            {
                                                Ok(prd) => prd,
                                                Err(error) => {
                                                    let _ = err_tx
                                                        .send(AppEvent::BranchError(format!(
                                                            "Cannot reload resume branch: {error}"
                                                        )))
                                                        .await;
                                                    return;
                                                }
                                            };
                                            let prd = match executor::prd_from_resume_review(
                                                &original_prd,
                                                &project,
                                                &description,
                                                &reviewed_stories,
                                                None,
                                            ) {
                                                Ok(prd) => prd,
                                                Err(error) => {
                                                    let _ = err_tx
                                                        .send(AppEvent::BranchError(format!(
                                                    "Refined resume plan is invalid: {error}"
                                                )))
                                                        .await;
                                                    return;
                                                }
                                            };
                                            if let Err(error) = executor::write_prd(&prd, &exec_cwd)
                                            {
                                                let _ = err_tx
                                                    .send(AppEvent::BranchError(format!(
                                                "Failed to persist refined resume plan: {error}"
                                            )))
                                                    .await;
                                                return;
                                            }
                                            spawn_executor(
                                                prd, exec_cwd, branch_tx, cfg, false, None,
                                            );
                                        });
                                    } else {
                                        let mut prd = executor::prd_from_review(
                                            &app.project,
                                            &app.branch_name,
                                            &app.description,
                                            &app.review_stories,
                                            app.decision_document.clone(),
                                            app.execution_mode.clone(),
                                        );
                                        attach_conversation_metadata(&mut prd, &app);
                                        if let Err(e) = executor::write_prd(&prd, &cwd) {
                                            app.planning_error =
                                                Some(format!("Failed to write prd.json: {}", e));
                                        } else {
                                            let planned_full_branch =
                                                if app.branch_name.starts_with("baro/") {
                                                    app.branch_name.clone()
                                                } else {
                                                    format!("baro/{}", app.branch_name)
                                                };
                                            let continuation_branch = if app.is_followup {
                                                match app.continuation_branch.clone() {
                                                    Some(branch) => Some(branch),
                                                    None => {
                                                        app.planning_error = Some(
                                                            "Follow-up has no established branch authority; refusing to execute on the current checkout."
                                                                .to_string(),
                                                        );
                                                        continue;
                                                    }
                                                }
                                            } else {
                                                None
                                            };
                                            let branch_cwd = cwd.clone();
                                            let branch_name_clone = planned_full_branch.clone();
                                            app.branch_name = continuation_branch
                                                .clone()
                                                .unwrap_or(planned_full_branch);
                                            if let Err(error) =
                                                begin_conversation_execution(&mut app, &cwd)
                                            {
                                                app.planning_error = Some(error);
                                                continue;
                                            }
                                            let cfg = match executor_config_from_app(&app) {
                                                Ok(config) => config,
                                                Err(error) => {
                                                    fail_conversation_run(
                                                        &mut app,
                                                        &format!(
                                                            "conversation context projection failed: {error}"
                                                        ),
                                                        &cwd,
                                                    );
                                                    app.planning_error = Some(error);
                                                    continue;
                                                }
                                            };
                                            app.start_execution();
                                            let exec_prd = prd;
                                            let exec_cwd = cwd.clone();
                                            let branch_tx = tx.clone();
                                            let err_tx = tx.clone();
                                            tokio::spawn(async move {
                                                // Follow-up (--continue): stay on the current branch
                                                // so it lands on the same PR. Otherwise ALWAYS cut a
                                                // fresh suffixed branch — sibling clones sharing an
                                                // origin would collide on `git push`.
                                                let actual_full_branch = if let Some(expected) =
                                                    continuation_branch
                                                {
                                                    match git::get_current_branch(&branch_cwd).await
                                                    {
                                                        Ok(name) if name == expected => name,
                                                        Ok(name) => {
                                                            let _ = err_tx.send(AppEvent::BranchError(
                                                                format!("Follow-up branch changed before execution: expected '{}', got '{}'.", expected, name)
                                                            )).await;
                                                            return;
                                                        }
                                                        Err(e) => {
                                                            let _ = err_tx.send(AppEvent::BranchError(
                                                        format!("Couldn't read current branch for follow-up: {}", e)
                                                    )).await;
                                                            return;
                                                        }
                                                    }
                                                } else {
                                                    match git::create_fresh_branch(
                                                        &branch_cwd,
                                                        &branch_name_clone,
                                                    )
                                                    .await
                                                    {
                                                        Ok(name) => name,
                                                        Err(e) => {
                                                            let _ = err_tx.send(AppEvent::BranchError(
                                                        format!("Branch creation failed: {}. Cannot proceed on main branch.", e)
                                                    )).await;
                                                            return;
                                                        }
                                                    }
                                                };
                                                // Persist the FULL "baro/<slug>-<suffix>" name to
                                                // prd.json — the TS orchestrator reads prd.branchName
                                                // verbatim, and a stripped name once made it commit
                                                // every story to a second un-prefixed branch,
                                                // breaking resume.
                                                let mut exec_prd = exec_prd;
                                                exec_prd.branch_name = actual_full_branch.clone();
                                                if let Err(e) =
                                                    executor::write_prd(&exec_prd, &exec_cwd)
                                                {
                                                    let _ = err_tx.send(AppEvent::BranchError(
                                                format!("Failed to persist suffixed branch in prd.json: {}", e)
                                            )).await;
                                                    return;
                                                }
                                                let _ = err_tx
                                                    .send(AppEvent::BranchReady(
                                                        actual_full_branch.clone(),
                                                    ))
                                                    .await;
                                                match git::get_current_branch(&exec_cwd).await {
                                                    Ok(ref actual)
                                                        if actual == &actual_full_branch => {}
                                                    Ok(actual) => {
                                                        let _ = err_tx.send(AppEvent::BranchError(
                                                    format!("Branch verification failed: expected '{}', got '{}'. Cannot proceed on main branch.", actual_full_branch, actual)
                                                )).await;
                                                        return;
                                                    }
                                                    Err(e) => {
                                                        let _ = err_tx.send(AppEvent::BranchError(
                                                    format!("Branch verification failed: {}. Cannot proceed on main branch.", e)
                                                )).await;
                                                        return;
                                                    }
                                                }
                                                spawn_executor(
                                                    exec_prd, exec_cwd, branch_tx, cfg, false, None,
                                                );
                                            });
                                        }
                                    }
                                }
                                KeyCode::Up | KeyCode::Char('k') => app.review_prev(),
                                KeyCode::Down | KeyCode::Char('j') => app.review_next(),
                                _ => {}
                            }
                        }
                    }
                    Screen::Execute => match key.code {
                        // Mid-run agent chat: same bottom-strip input, one JSON
                        // line to the orchestrator's stdin on Enter.
                        KeyCode::Esc if app.agent_msg_input.is_some() => {
                            app.agent_msg_input = None;
                        }
                        KeyCode::Backspace if app.agent_msg_input.is_some() => {
                            if let Some((_, s)) = app.agent_msg_input.as_mut() {
                                s.pop();
                            }
                        }
                        KeyCode::Char(c) if app.agent_msg_input.is_some() => {
                            if let Some((_, s)) = app.agent_msg_input.as_mut() {
                                s.push(c);
                            }
                        }
                        KeyCode::Enter if app.agent_msg_input.is_some() => {
                            if let Some((id, text)) = app.agent_msg_input.take() {
                                let text = text.trim().to_string();
                                if !text.is_empty() {
                                    let runtime_request_id = if id == app::DIALOGUE_AGENT_ID {
                                        let request_id = app.next_conversation_request_id();
                                        match app.conversation.begin_request(&request_id, &text) {
                                            Ok(()) => {
                                                persist_conversation(&app.conversation, &cwd);
                                                Some(request_id)
                                            }
                                            Err(error) => {
                                                app.conversation_error = Some(format!(
                                                    "cannot send conversation message: {error}"
                                                ));
                                                continue;
                                            }
                                        }
                                    } else {
                                        None
                                    };
                                    let line = message_command_line(
                                        &id,
                                        &text,
                                        runtime_request_id.as_deref(),
                                    );
                                    let sent = app
                                        .orchestrator_stdin
                                        .as_ref()
                                        .is_some_and(|sender| sender.try_send(line).is_ok());
                                    if !sent {
                                        if let Some(request_id) = runtime_request_id.as_deref() {
                                            let _ = app.conversation.apply_runtime_failure(
                                                request_id,
                                                "orchestrator command lane is unavailable",
                                            );
                                            persist_conversation(&app.conversation, &cwd);
                                            app.conversation_error = Some(
                                                "Collective conversation is unavailable because the run command lane closed."
                                                    .to_string(),
                                            );
                                        }
                                    }
                                    app.echo_user_message(&id, &text);
                                }
                            }
                        }
                        // The same durable conversation owns status questions and
                        // implementation follow-ups after a run. A Ready response
                        // later re-plans on the current branch.
                        KeyCode::Char('f') if app.done => {
                            app.start_conversation();
                            app.conversation_input.clear();
                        }
                        KeyCode::Char('m') if !app.done => {
                            if let Some(id) = app.message_target() {
                                app.agent_msg_input = Some((id, String::new()));
                            }
                        }
                        KeyCode::Char('c') if !app.done => {
                            app.open_dialogue();
                        }
                        KeyCode::Char('r') if app.done && app.exit_reason.is_some() => {
                            let prd_path = cwd.join("prd.json");
                            match std::fs::read_to_string(&prd_path)
                                .map_err(|e| e.to_string())
                                .and_then(|c| {
                                    serde_json::from_str::<executor::PrdFile>(&c)
                                        .map_err(|e| e.to_string())
                                }) {
                                Ok(prd) => {
                                    if app.conversation.goal_envelope().is_none() {
                                        restore_conversation_from_prd(&mut app, &prd, &cwd);
                                    }
                                    let full_branch = if prd.branch_name.starts_with("baro/") {
                                        prd.branch_name.clone()
                                    } else {
                                        format!("baro/{}", prd.branch_name)
                                    };
                                    app.is_resume = true;
                                    app.project = prd.project.clone();
                                    app.branch_name = full_branch.clone();
                                    app.continuation_branch = Some(full_branch.clone());
                                    app.description = prd.description.clone();
                                    app.review_stories = review_stories_from_prd(&prd);
                                    if let Err(error) = begin_conversation_execution(&mut app, &cwd)
                                    {
                                        app.exit_reason = Some(error);
                                        continue;
                                    }
                                    let exec_cwd = cwd.clone();
                                    let branch_cwd = cwd.clone();
                                    let branch_tx = tx.clone();
                                    let err_tx = tx.clone();
                                    let cfg = match executor_config_from_app(&app) {
                                        Ok(config) => config,
                                        Err(error) => {
                                            fail_conversation_run(
                                                &mut app,
                                                &format!(
                                                    "conversation context projection failed: {error}"
                                                ),
                                                &cwd,
                                            );
                                            app.exit_reason = Some(error);
                                            continue;
                                        }
                                    };
                                    app.start_execution();
                                    tokio::spawn(async move {
                                        if let Err(e) =
                                            git::checkout_existing_branch(&branch_cwd, &full_branch)
                                                .await
                                        {
                                            let _ = err_tx.send(AppEvent::BranchError(
                                                format!("Branch checkout failed: {}. Cannot rerun this checkpoint.", e)
                                            )).await;
                                            return;
                                        }
                                        match git::get_current_branch(&exec_cwd).await {
                                            Ok(ref actual) if actual == &full_branch => {}
                                            Ok(actual) => {
                                                let _ = err_tx.send(AppEvent::BranchError(
                                                    format!("Branch verification failed: expected '{}', got '{}'. Cannot rerun this checkpoint.", full_branch, actual)
                                                )).await;
                                                return;
                                            }
                                            Err(e) => {
                                                let _ = err_tx.send(AppEvent::BranchError(
                                                    format!("Branch verification failed: {}. Cannot rerun this checkpoint.", e)
                                                )).await;
                                                return;
                                            }
                                        }
                                        spawn_executor(prd, exec_cwd, branch_tx, cfg, false, None);
                                    });
                                }
                                Err(e) => {
                                    app.exit_reason =
                                        Some(format!("Failed to read prd.json for rerun: {}", e));
                                }
                            }
                        }
                        KeyCode::Char('q') => return Ok(()),
                        // Un-pin the activity view from an explorer-selected agent.
                        KeyCode::Esc => {
                            app.activity_filter = None;
                        }
                        // Full terminal clear on view change — ratatui's
                        // `Clear` widget doesn't reliably blank every cell,
                        // so old view content bleeds through otherwise.
                        KeyCode::Char('1') => {
                            app.main_view = app::MainView::Activity;
                            let _ = terminal.clear();
                        }
                        KeyCode::Char('2') => {
                            app.main_view = app::MainView::Plan;
                            let _ = terminal.clear();
                        }
                        KeyCode::Char('3') => {
                            app.main_view = app::MainView::Stats;
                            let _ = terminal.clear();
                        }
                        KeyCode::Char('4') => {
                            app.main_view = app::MainView::Diff;
                            let _ = terminal.clear();
                        }
                        KeyCode::Char('5') => {
                            app.main_view = app::MainView::Decisions;
                            let _ = terminal.clear();
                        }
                        KeyCode::Char('e') => {
                            app.explorer_visible = !app.explorer_visible;
                            if !app.explorer_visible {
                                app.focus = app::WorkbenchFocus::Main;
                            }
                            let _ = terminal.clear();
                        }
                        KeyCode::Char('[') => app.explorer_narrower(),
                        KeyCode::Char(']') => app.explorer_wider(),
                        // With the explorer on screen Tab cycles focus zones;
                        // when it's hidden (`e` or a narrow terminal) it keeps
                        // the legacy active-agent switching.
                        KeyCode::Tab | KeyCode::BackTab => {
                            let back = key.code == KeyCode::BackTab
                                || key.modifiers.contains(KeyModifiers::SHIFT);
                            let width = terminal.size().map(|s| s.width).unwrap_or(120);
                            let explorer_shown =
                                app.explorer_visible && width >= screens::execute::BP_EXPLORER;
                            if explorer_shown {
                                app.focus = if back {
                                    app.focus.prev()
                                } else {
                                    app.focus.next()
                                };
                            } else if back {
                                app.prev_log();
                            } else {
                                app.next_log();
                            }
                        }
                        KeyCode::Left => app.prev_view(),
                        KeyCode::Right => app.next_view(),
                        // ↑↓ act on the *visible* focus zone: a hidden explorer
                        // (toggled off or narrow terminal) can't be current, so
                        // its stale focus must not swallow scrolling.
                        KeyCode::Up | KeyCode::Char('k') => match effective_focus(&app, terminal) {
                            app::WorkbenchFocus::Agents => app.explorer_agents_move(-1),
                            app::WorkbenchFocus::Changes => app.explorer_files_move(-1),
                            app::WorkbenchFocus::Main => match app.main_view {
                                app::MainView::Activity => {
                                    let inner_h = terminal
                                        .size()
                                        .map(|s| s.height.saturating_sub(12) as usize)
                                        .unwrap_or(20);
                                    let active_ids = app.active_story_ids();
                                    let selected_id = app
                                        .activity_filter
                                        .clone()
                                        .or_else(|| active_ids.get(app.selected_log_index).cloned())
                                        .unwrap_or_default();
                                    if !app.review_logs.is_empty() && active_ids.is_empty() {
                                        let total = app.review_logs.len();
                                        app.review_log_scroll_up(1, total, inner_h);
                                    } else if let Some(story) = app.active_stories.get(&selected_id)
                                    {
                                        let total = if story.activity.is_empty() {
                                            story.logs.len()
                                        } else {
                                            story.activity.len()
                                        };
                                        app.log_scroll_up(1, total, inner_h);
                                    }
                                }
                                app::MainView::Plan => app.dag_scroll_up(),
                                app::MainView::Diff => app.diff_scroll_up(),
                                app::MainView::Decisions => {
                                    app.decisions_scroll = app.decisions_scroll.saturating_sub(1);
                                }
                                app::MainView::Stats => {}
                            },
                        },
                        KeyCode::Down | KeyCode::Char('j') => match effective_focus(&app, terminal)
                        {
                            app::WorkbenchFocus::Agents => app.explorer_agents_move(1),
                            app::WorkbenchFocus::Changes => app.explorer_files_move(1),
                            app::WorkbenchFocus::Main => match app.main_view {
                                app::MainView::Activity => {
                                    let inner_h = terminal
                                        .size()
                                        .map(|s| s.height.saturating_sub(12) as usize)
                                        .unwrap_or(20);
                                    let active_ids = app.active_story_ids();
                                    let selected_id = app
                                        .activity_filter
                                        .clone()
                                        .or_else(|| active_ids.get(app.selected_log_index).cloned())
                                        .unwrap_or_default();
                                    if !app.review_logs.is_empty() && active_ids.is_empty() {
                                        let total = app.review_logs.len();
                                        app.review_log_scroll_down(1, total, inner_h);
                                    } else if let Some(story) = app.active_stories.get(&selected_id)
                                    {
                                        let total = if story.activity.is_empty() {
                                            story.logs.len()
                                        } else {
                                            story.activity.len()
                                        };
                                        app.log_scroll_down(1, total, inner_h);
                                    }
                                }
                                app::MainView::Plan => {
                                    let total = app.dag_line_count();
                                    let visible = terminal
                                        .size()
                                        .map(|s| s.height.saturating_sub(10))
                                        .unwrap_or(20);
                                    app.dag_scroll_down(total, visible);
                                }
                                app::MainView::Diff => app.diff_scroll_down(),
                                app::MainView::Decisions => {
                                    app.decisions_scroll = app.decisions_scroll.saturating_add(1);
                                }
                                app::MainView::Stats => {}
                            },
                        },
                        _ => {}
                    },
                }
            }
            Some(AppEvent::OrchestratorStdin(sender)) => {
                // Headless: our own stdin is the cloud→run command lane. A single
                // StdinHub reader owns stdin (shared with the confirm-mode gate);
                // hand it the execution-phase command sender.
                if headless {
                    StdinHub::global().set_orchestrator(sender.clone());
                }
                app.orchestrator_stdin = Some(sender);
            }
            Some(AppEvent::Tick) => {
                app.tick_count += 1;
            }
            None => break,
        }
    }
    // The JSON `done` event is the authoritative outcome. The orchestrator
    // process can exit cleanly after emitting `success:false`; automation must
    // still receive a non-zero baro exit code instead of mistaking that for a
    // successful run.
    if headless {
        if let Some(reason) = headless_failure_reason(&app) {
            return Err(reason.into());
        }
    }
    Ok(())
}

fn headless_failure_reason(app: &App) -> Option<String> {
    app.exit_reason.clone()
}

fn conversation_intent(app: &App) -> conversation_runner::ConversationIntent {
    if matches!(
        app.conversation.phase(),
        ConversationPhase::Completed | ConversationPhase::Failed
    ) {
        return conversation_runner::ConversationIntent::Chat;
    }
    if app
        .conversation
        .transcript()
        .iter()
        .rev()
        .find(|turn| turn.role == conversation::TranscriptRole::Assistant)
        .and_then(|turn| turn.kind)
        == Some(ConversationKind::Clarify)
    {
        conversation_runner::ConversationIntent::Clarification
    } else {
        conversation_runner::ConversationIntent::Goal
    }
}

fn conversation_model(app: &App) -> Option<String> {
    app.override_model.clone().or_else(|| {
        (app.llm == app::LlmProvider::OpenAI)
            .then(|| app.architect_model.clone())
            .flatten()
    })
}

fn spawn_pending_conversation(
    app: &mut App,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
    intent: conversation_runner::ConversationIntent,
) {
    let session = app.conversation.clone();
    let request_id = session
        .pending_request_id()
        .expect("spawn_pending_conversation requires a pending request")
        .to_string();
    let cwd = cwd.to_path_buf();
    let llm = app.llm;
    let model = conversation_model(app);
    let openai_api_key = app.openai_api_key.clone();
    let openai_base_url = app.openai_base_url.clone();
    app.conversation_busy = true;
    app.conversation_error = None;
    app.screen = Screen::Conversation;
    persist_conversation(&app.conversation, &cwd);

    tokio::spawn(async move {
        let turn_timeout_ms = conversation_frontdoor::conversation_turn_timeout_ms();
        let provider_timeout_ms =
            conversation_frontdoor::conversation_provider_timeout_ms(turn_timeout_ms);
        let result = conversation_runner::run_conversation_turn(
            &session,
            intent,
            conversation_runner::ConversationRunOptions {
                cwd: &cwd,
                llm,
                model: model.as_deref(),
                timeout_ms: turn_timeout_ms,
                provider_timeout_ms,
                openai_api_key: openai_api_key.as_deref(),
                openai_base_url: openai_base_url.as_deref(),
            },
        )
        .await;
        match result {
            Ok(response) => {
                let _ = tx.send(AppEvent::ConversationResponse(response)).await;
            }
            Err(error) => {
                let _ = tx
                    .send(AppEvent::ConversationError {
                        request_id,
                        error: error.message,
                        log_path: error.log_path,
                    })
                    .await;
            }
        }
    });
}

fn submit_conversation_message(
    app: &mut App,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
    text: String,
) -> Result<(), String> {
    if !app.conversation_accepts_input() {
        return Err("conversation is not accepting a new message".to_string());
    }
    if matches!(
        app.conversation.phase(),
        ConversationPhase::Completed | ConversationPhase::Failed
    ) {
        // A terminal phase permits a follow-up conversation, but only an
        // actually established run branch authorizes same-PR execution. A
        // failed intake/planning attempt may still be sitting on main.
        app.is_followup = app.continuation_branch.is_some();
    }
    let intent = conversation_intent(app);
    let request_id = app.next_conversation_request_id();
    app.conversation
        .begin_request(request_id, text)
        .map_err(|error| error.to_string())?;
    app.conversation_input.clear();
    spawn_pending_conversation(app, cwd, tx, intent);
    Ok(())
}

/// Apply one conversation response and perform the caller-owned lifecycle
/// action. A non-quick `ready` response reaches this function only after
/// repository validation, so its decision document can be handed directly to
/// Planner without invoking Architect a second time.
async fn accept_conversation_response(
    app: &mut App,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
    response: ConversationWireResponse,
    headless: bool,
    prevalidated: Option<PrevalidatedArchitect>,
) -> Result<(), String> {
    let kind = response.kind;
    if prevalidated.is_some() && kind != ConversationKind::Ready {
        return Err("prevalidated Architect data requires a ready response".to_string());
    }
    let request_id = response.request_id.clone();
    let message = response.message.clone();
    let questions = response.questions.clone();
    match apply_or_close_conversation_response(app, response) {
        Ok(conversation::ApplyOutcome::Duplicate) => return Ok(()),
        Ok(conversation::ApplyOutcome::Accepted(_)) => {}
        Err(error) => {
            persist_conversation(&app.conversation, cwd);
            return Err(error);
        }
    }
    persist_conversation(&app.conversation, cwd);

    if headless {
        println!(
            "{}",
            serde_json::json!({
                "type": "conversation_response",
                "session_id": app.conversation.session_id(),
                "request_id": request_id,
                "kind": match kind {
                    ConversationKind::Ready => "ready",
                    ConversationKind::Clarify => "clarify",
                    ConversationKind::Answer => "answer",
                },
                "message": message,
                "questions": questions,
            })
        );
    }

    match kind {
        ConversationKind::Ready => {
            let result = match prevalidated {
                Some(architect) => {
                    start_prevalidated_planning_from_conversation(app, cwd, tx, headless, architect)
                }
                None => start_planning_from_conversation(app, cwd, tx, headless),
            };
            result.map_err(|error| format!("goal handoff failed: {error}"))
        }
        ConversationKind::Clarify | ConversationKind::Answer => {
            app.screen = Screen::Conversation;
            if !headless {
                return Ok(());
            }
            println!(
                "{}",
                serde_json::json!({
                    "type": "conversation_needs_input",
                    "session_id": app.conversation.session_id(),
                    "after_request_id": request_id,
                })
            );
            let session_id = app.conversation.session_id().to_string();
            match StdinHub::global()
                .await_conversation_message(&session_id, &request_id)
                .await
            {
                Some(text) => submit_conversation_message(app, cwd, tx, text)
                    .map_err(|error| format!("cannot continue conversation: {error}")),
                None => Err(
                    "conversation requires another user message, but the headless stdin transport closed"
                        .to_string(),
                ),
            }
        }
    }
}

fn start_planning_from_conversation(
    app: &mut App,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
    headless: bool,
) -> Result<(), String> {
    let handoff = app
        .conversation
        .take_ready_handoff()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "conversation produced no new ready handoff".to_string())?;
    app.goal_input = handoff.planning_prompt;
    if app.is_followup {
        std::env::set_var("BARO_CONTINUE", "1");
    }
    app.conversation
        .transition_to(ConversationPhase::Planning)
        .map_err(|error| error.to_string())?;
    app.conversation
        .record_system_turn("Goal accepted. Architect and Planner are starting.")
        .map_err(|error| error.to_string())?;
    persist_conversation(&app.conversation, cwd);
    if let Some(context) = load_project_instructions(cwd) {
        app.claude_md_content = Some(context);
        app.start_planning();
        spawn_planner(app, cwd, tx, headless, None);
    } else {
        app.start_context();
        spawn_context_builder(cwd, tx);
    }
    Ok(())
}

fn start_prevalidated_planning_from_conversation(
    app: &mut App,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
    headless: bool,
    architect: PrevalidatedArchitect,
) -> Result<(), String> {
    let handoff = app
        .conversation
        .take_ready_handoff()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "conversation produced no new ready handoff".to_string())?;
    app.goal_input = handoff.planning_prompt;
    if app.is_followup {
        std::env::set_var("BARO_CONTINUE", "1");
    }
    app.conversation
        .transition_to(ConversationPhase::Planning)
        .map_err(|error| error.to_string())?;
    app.conversation
        .record_system_turn("Goal validated against repository evidence. Planner is starting.")
        .map_err(|error| error.to_string())?;
    persist_conversation(&app.conversation, cwd);

    app.claude_md_content = Some(architect.repository_context);
    app.start_planning();
    spawn_planner(app, cwd, tx, headless, Some(architect.decision_document));
    Ok(())
}

/// Stage A of planning: Architect, then execution-mode contract
/// resolution. `--mode auto` runs the intake; interactively that pauses
/// at the ModePicker (IntakeReady) and stage B is spawned on confirm,
/// otherwise the flow continues straight into the planner.
/// Per-line progress sink for the planner/architect/intake phases.
/// Headless emits a `story_log` JSON line to stdout (serde-escaped) that the
/// dashboard renders under `id:"plan"`; TUI routes to the planning screen via
/// AppEvent. `try_send` keeps the sink synchronous for the subprocess reader.
fn plan_progress_sink(headless: bool, tx: mpsc::Sender<AppEvent>) -> impl Fn(&str) {
    move |msg: &str| {
        if headless {
            if let Ok(line) = serde_json::to_string(&serde_json::json!({
                "type": "story_log", "id": "plan", "line": msg,
            })) {
                println!("{}", line);
            }
        } else {
            let _ = tx.try_send(AppEvent::PlanProgress(msg.to_string()));
        }
    }
}

/// Per-event sink for the planner/architect phases, whose stdout is now a
/// live BaroEvent stream (`story_log`/`activity` under id "plan"). Headless
/// echoes each raw JSON line to our stdout so the control plane forwards it
/// verbatim — mirrors `orchestrator_client`'s `echo_raw`; TUI parses out the
/// human line into the planning screen via AppEvent. `try_send` keeps the
/// sink synchronous for the subprocess reader.
fn plan_event_sink(headless: bool, tx: mpsc::Sender<AppEvent>) -> impl Fn(&str) {
    move |raw: &str| {
        if headless {
            println!("{}", raw);
        } else if let Some(line) = planner_host::line_from_event(raw) {
            let _ = tx.try_send(AppEvent::PlanProgress(line));
        }
    }
}

fn spawn_planner(
    app: &App,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
    headless: bool,
    prevalidated_decision_doc: Option<String>,
) {
    let goal = app.goal_input.clone();
    let planner = app.planner;
    let cwd = cwd.to_path_buf();
    let model = app.model_for_phase("planning");
    let architect_model = app.model_for_phase("architect");
    let context = app.claude_md_content.clone();
    let quick = app.quick;
    let mode = app.mode.clone();
    let confirm_mode = app.confirm_mode;
    // Per-phase routing lets hybrid runs split Architect/Planner from
    // Story/Critic/Surgeon; unset overrides fall back to the global --llm.
    let architect_llm = app.architect_llm;
    let planner_llm = app.planner_llm;
    let openai_api_key = app.openai_api_key.clone();
    let openai_base_url = app.openai_base_url.clone();
    let effort = app.effort.clone();

    tokio::spawn(async move {
        // Resolve operator-fixed contracts before the Architect so the
        // mode-aware OpenAI planning phases see the same execution shape. Auto
        // remains undecided here: the Architect may run its own intake, and
        // the shared intake below can still incorporate its decision document.
        let fixed_mode_json = fixed_mode_contract(quick, &mode);

        // Quick mode skips the Architect — its job is aligning parallel
        // agents, and quick runs are single-agent. Still emit
        // ArchitectSkipped so the TUI shows why there's no design doc.
        let decision_doc = if quick {
            let _ = tx
                .send(AppEvent::ArchitectSkipped(
                    "Quick mode — no design document needed for a single-story run.".to_string(),
                ))
                .await;
            None
        } else if let Some(doc) = prevalidated_decision_doc {
            // Conversation pre-acceptance already ran the repository-aware
            // Architect. Publish the usual lifecycle event, but never spend a
            // second model call rediscovering the same decision document.
            let _ = tx.send(AppEvent::ArchitectComplete(doc.clone())).await;
            Some(doc)
        } else {
            // The Architect runs for every backend (run-architect.ts
            // handles all providers) — only quick mode skips it. Routing
            // keys off `architect_llm`, not the legacy `planner` enum.
            let _ = tx.send(AppEvent::ArchitectStarted).await;
            match architect_runner::run_architect(
                &goal,
                &cwd,
                architect_llm,
                architect_model.as_deref(),
                context.as_deref(),
                fixed_mode_json.as_deref(),
                openai_api_key.as_deref(),
                openai_base_url.as_deref(),
                &effort,
                plan_event_sink(headless, tx.clone()),
            )
            .await
            {
                Ok(doc) => {
                    let _ = tx.send(AppEvent::ArchitectComplete(doc.clone())).await;
                    Some(doc)
                }
                Err(e) => {
                    // Non-fatal: the planner runs without an authoritative
                    // spec; the TUI surfaces why this run might drift.
                    let _ = tx
                        .send(AppEvent::ArchitectSkipped(format!(
                            "Architect phase failed: {}. Falling back to planner-only flow.",
                            e
                        )))
                        .await;
                    None
                }
            }
        };

        let _ = planner; // legacy field kept on App for the welcome-screen wizard

        // Contract resolution: --quick and an explicit --mode never
        // consult the intake; auto runs it, and interactive auto pauses
        // for the picker instead of continuing.
        let mode_json = if let Some(contract) = fixed_mode_json {
            Some(contract)
        } else {
            let contract = intake_runner::run_intake(
                &goal,
                &cwd,
                planner_llm,
                model.as_deref(),
                context.as_deref(),
                decision_doc.as_deref(),
                openai_api_key.as_deref(),
                openai_base_url.as_deref(),
                plan_progress_sink(headless, tx.clone()),
                plan_event_sink(headless, tx.clone()),
            )
            .await;
            if headless {
                // Ask-after-planning (opt-in): emit the proposal and block for a
                // confirm_mode command (≤120s). Without the flag, headless stays
                // fire-and-forget — no emit, no wait, byte-for-byte as before.
                if confirm_mode {
                    Some(resolve_confirm_mode(contract).await)
                } else {
                    Some(contract)
                }
            } else {
                let _ = tx
                    .send(AppEvent::IntakeReady {
                        decision_doc,
                        contract_json: contract,
                    })
                    .await;
                return;
            }
        };

        let spec = PlannerRunSpec {
            goal,
            cwd,
            planner_llm,
            model,
            context,
            decision_doc,
            quick,
            openai_api_key,
            openai_base_url,
            effort,
            mode_json,
        };
        if progressive_planning_enabled(headless) {
            let _ = tx.send(AppEvent::ProgressivePlanningPrepared(spec)).await;
        } else {
            run_planner_and_report(spec, tx, headless, None).await;
        }
    });
}

/// Return the immutable mode contract selected directly by the operator.
/// Auto mode deliberately returns `None`: its contract depends on intake and,
/// unlike explicit `--mode`, may use the Architect's decision document.
fn fixed_mode_contract(quick: bool, mode: &str) -> Option<String> {
    if quick {
        Some(user_mode_contract("focused", "Quick mode"))
    } else if mode != "auto" {
        Some(user_mode_contract(
            mode,
            &format!("User selected {} mode.", mode),
        ))
    } else {
        None
    }
}

/// Stage B: the planner proper, then PlanReady/PlanError.
fn spawn_planner_stage_b(app: &App, cwd: &Path, tx: mpsc::Sender<AppEvent>, mode_json: String) {
    let goal = app.goal_input.clone();
    let cwd = cwd.to_path_buf();
    let model = app.model_for_phase("planning");
    let context = app.claude_md_content.clone();
    let decision_doc = app.decision_document.clone();
    let planner_llm = app.planner_llm;
    let openai_api_key = app.openai_api_key.clone();
    let openai_base_url = app.openai_base_url.clone();
    let effort = app.effort.clone();
    tokio::spawn(async move {
        run_planner_and_report(
            PlannerRunSpec {
                goal,
                cwd,
                planner_llm,
                model,
                context,
                decision_doc,
                quick: false, // the picker never shows in quick mode
                openai_api_key,
                openai_base_url,
                effort,
                mode_json: Some(mode_json),
            },
            tx,
            false, // stage B only runs interactively (the picker never shows headless)
            None,
        )
        .await;
    });
}

/// Build a "user"-sourced ModeContract for an explicitly chosen mode
/// (--mode, --quick, or a picker override). Shapes mirror the TS
/// heuristic contracts.
fn user_mode_contract(mode: &str, reason: &str) -> String {
    let v = match mode {
        "sequential" => serde_json::json!({
            "mode": "sequential", "confidence": 1, "reason": reason,
            "maxStories": 5, "parallelism": 1, "source": "user",
        }),
        "parallel" => serde_json::json!({
            "mode": "parallel", "confidence": 1, "reason": reason,
            "source": "user",
        }),
        _ => serde_json::json!({
            "mode": "focused", "confidence": 1, "reason": reason,
            "maxStories": 1, "parallelism": 1, "source": "user",
        }),
    };
    v.to_string()
}

/// CLI values override repository configuration even when the explicit value
/// is zero, because zero is the meaningful "unlimited" setting.
fn resolve_parallel_limit(config: Option<u32>, cli: Option<u32>) -> u32 {
    cli.or(config).unwrap_or(0)
}

async fn run_planner_and_report(
    spec: PlannerRunSpec,
    tx: mpsc::Sender<AppEvent>,
    headless: bool,
    progressive: Option<ProgressivePlannerRuntime>,
) {
    let outcome =
        planner_host::run_planner(spec, progressive, plan_event_sink(headless, tx.clone())).await;
    let _ = tx.send(AppEvent::PlannerFinished(outcome)).await;
}

/// Read existing repository instructions without changing the checkout.
/// When both conventions exist, preserve both under explicit labels so every
/// backend receives the same source material without Baro manufacturing or
/// overwriting instruction files before the goal is accepted.
fn load_project_instructions(cwd: &Path) -> Option<String> {
    let mut sections: Vec<(&str, String)> = Vec::new();
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let path = cwd.join(name);
        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };
        let trimmed = content.trim();
        if trimmed.is_empty() || sections.iter().any(|(_, body)| body == trimmed) {
            continue;
        }
        sections.push((name, trimmed.to_string()));
    }
    if sections.is_empty() {
        None
    } else {
        Some(
            sections
                .into_iter()
                .map(|(name, body)| format!("# Instructions from {name}\n\n{body}"))
                .collect::<Vec<_>>()
                .join("\n\n"),
        )
    }
}

fn spawn_context_builder(cwd: &Path, tx: mpsc::Sender<AppEvent>) {
    let cwd = cwd.to_path_buf();
    tokio::spawn(async move {
        match context::build_context(&cwd).await {
            Ok(content) => {
                let _ = tx.send(AppEvent::ContextReady(content)).await;
            }
            Err(e) => {
                let _ = tx
                    .send(AppEvent::ContextError(format!(
                        "Failed to build context: {}",
                        e
                    )))
                    .await;
            }
        }
    });
}

/// Headless plan confirmation: write the PRD, create the run branch, and spawn
/// the orchestrator (streaming its events to stdout via echo_raw). Mirrors the
/// TUI Review→Enter fresh path, minus the interactive review.
fn confirm_and_execute(
    app: &mut App,
    stories: Vec<ReviewStory>,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
) {
    app.review_stories = stories;
    let mut prd = executor::prd_from_review(
        &app.project,
        &app.branch_name,
        &app.description,
        &app.review_stories,
        app.decision_document.clone(),
        app.execution_mode.clone(),
    );
    attach_conversation_metadata(&mut prd, app);
    if let Err(e) = executor::write_prd(&prd, cwd) {
        let _ = tx.try_send(AppEvent::BranchError(format!(
            "Failed to write prd.json: {}",
            e
        )));
        return;
    }
    let planned_full_branch = if app.branch_name.starts_with("baro/") {
        app.branch_name.clone()
    } else {
        format!("baro/{}", app.branch_name)
    };
    let continuation_branch = if app.is_followup {
        match app.continuation_branch.clone() {
            Some(branch) => Some(branch),
            None => {
                let _ = tx.try_send(AppEvent::BranchError(
                    "Follow-up has no established branch authority; refusing to execute on the current checkout."
                        .to_string(),
                ));
                return;
            }
        }
    } else {
        None
    };
    app.branch_name = continuation_branch
        .clone()
        .unwrap_or_else(|| planned_full_branch.clone());
    if let Err(error) = begin_conversation_execution(app, cwd) {
        let _ = tx.try_send(AppEvent::BranchError(error));
        return;
    }
    let cfg = match executor_config_from_app(app) {
        Ok(config) => config,
        Err(error) => {
            fail_conversation_run(
                app,
                &format!("conversation context projection failed: {error}"),
                cwd,
            );
            let _ = tx.try_send(AppEvent::BranchError(error));
            return;
        }
    };
    app.start_execution();
    let exec_cwd = cwd.to_path_buf();
    let branch_cwd = cwd.to_path_buf();
    tokio::spawn(async move {
        let actual_full_branch = if let Some(expected) = continuation_branch {
            match git::get_current_branch(&branch_cwd).await {
                Ok(name) if name == expected => name,
                Ok(name) => {
                    let _ = tx
                        .send(AppEvent::BranchError(format!(
                            "Follow-up branch changed before execution: expected '{}', got '{}'.",
                            expected, name
                        )))
                        .await;
                    return;
                }
                Err(error) => {
                    let _ = tx
                        .send(AppEvent::BranchError(format!(
                            "Couldn't read current branch for follow-up: {error}"
                        )))
                        .await;
                    return;
                }
            }
        } else {
            match git::create_fresh_branch(&branch_cwd, &planned_full_branch).await {
                Ok(name) => name,
                Err(e) => {
                    let _ = tx
                        .send(AppEvent::BranchError(format!(
                            "Branch creation failed: {}",
                            e
                        )))
                        .await;
                    return;
                }
            }
        };
        let mut exec_prd = prd;
        exec_prd.branch_name = actual_full_branch.clone();
        if let Err(e) = executor::write_prd(&exec_prd, &exec_cwd) {
            let _ = tx
                .send(AppEvent::BranchError(format!(
                    "Failed to persist branch in prd.json: {}",
                    e
                )))
                .await;
            return;
        }
        let _ = tx.send(AppEvent::BranchReady(actual_full_branch)).await;
        spawn_executor(exec_prd, exec_cwd, tx, cfg, true, None);
    });
}

async fn begin_progressive_execution(
    app: &mut App,
    spec: PlannerRunSpec,
    cwd: &Path,
    tx: mpsc::Sender<AppEvent>,
) -> Result<(), String> {
    if app.is_followup || app.is_resume {
        return Err(
            "progressive planning v1 supports fresh headless runs only; resume/follow-up keeps the complete-plan barrier"
                .to_string(),
        );
    }

    let generated = progressive_planning::ProgressivePlanningIds::generate();
    let run_id = std::env::var("BARO_RUN_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| generated.run_id().to_string());
    let ids = progressive_planning::ProgressivePlanningIds::new(
        run_id.clone(),
        generated.planning_id().to_string(),
    )
    .map_err(|error| error.to_string())?;
    // The TS orchestrator and Planner billing/session lanes must inherit the
    // exact identity stamped into runtimeGraph.
    std::env::set_var("BARO_RUN_ID", ids.run_id());

    let execution_mode = spec
        .mode_json
        .as_deref()
        .map(serde_json::from_str::<serde_json::Value>)
        .transpose()
        .map_err(|error| format!("invalid progressive execution mode: {error}"))?;
    let mut bootstrap = progressive_planning::build_progressive_bootstrap_prd(
        progressive_planning::ProgressiveBootstrapInput {
            cwd,
            goal: &spec.goal,
            ids: &ids,
            decision_document: spec.decision_doc.as_deref(),
            execution_mode: execution_mode.as_ref(),
            conversation_session_id: None,
            goal_envelope: None,
        },
    )
    .map_err(|error| error.to_string())?;
    attach_conversation_metadata(&mut bootstrap, app);

    let actual_branch = git::create_fresh_branch(cwd, &bootstrap.branch_name)
        .await
        .map_err(|error| format!("progressive branch creation failed: {error}"))?;
    bootstrap.branch_name = actual_branch.clone();
    executor::write_prd(&bootstrap, cwd)
        .map_err(|error| format!("could not persist progressive bootstrap PRD: {error}"))?;

    app.project = bootstrap.project.clone();
    app.branch_name = actual_branch.clone();
    app.description = bootstrap.description.clone();
    app.execution_mode = bootstrap.execution_mode.clone();
    app.review_stories.clear();
    begin_conversation_execution(app, cwd)?;
    let executor_config = executor_config_from_app(app)?;
    app.start_execution();
    let _ = tx.send(AppEvent::BranchReady(actual_branch)).await;

    let planning_id = ids.planning_id().to_string();
    let orchestrator_stdin = spawn_executor(
        bootstrap.clone(),
        cwd.to_path_buf(),
        tx.clone(),
        executor_config,
        true,
        Some(planning_id.clone()),
    );
    // Queue the open command immediately. The TS CLI has a bounded startup
    // buffer until the Board persists and exposes its PlanningFeed authority.
    orchestrator_stdin
        .send(
            serde_json::json!({
                "type": "planning_open",
                "run_id": ids.run_id(),
                "planning_id": ids.planning_id(),
            })
            .to_string(),
        )
        .await
        .map_err(|_| "orchestrator command lane closed before Planner start".to_string())?;

    let bootstrap_json = serde_json::to_string(&bootstrap)
        .map_err(|error| format!("could not serialize progressive bootstrap: {error}"))?;
    let runtime =
        ProgressivePlannerRuntime::new(run_id, planning_id, bootstrap_json, orchestrator_stdin);
    tokio::spawn(async move {
        run_planner_and_report(spec, tx, true, Some(runtime)).await;
    });
    Ok(())
}

fn spawn_executor(
    _prd: executor::PrdFile,
    cwd: PathBuf,
    tx: mpsc::Sender<AppEvent>,
    config: executor::ExecutorConfig,
    echo_raw: bool,
    progressive_planning_id: Option<String>,
) -> mpsc::Sender<String> {
    // Bridge the orchestrator's BaroEvents to AppEvent::Baro so
    // app/screens stay untouched.
    let (exec_tx, mut exec_rx) = mpsc::channel::<BaroEvent>(256);

    // TUI→orchestrator command lane (agent chat): hand the app loop the
    // sender, the child-stdin writer consumes the receiver.
    let (stdin_tx, stdin_rx) = mpsc::channel::<String>(256);
    let _ = tx.try_send(AppEvent::OrchestratorStdin(stdin_tx.clone()));

    let tx_fwd = tx.clone();
    tokio::spawn(async move {
        while let Some(ev) = exec_rx.recv().await {
            if tx_fwd.send(AppEvent::Baro(ev)).await.is_err() {
                break;
            }
        }
    });

    // Preserve PRD light/standard/heavy classes only for the opt-in collective
    // market so workers can bid by tier. Legacy intentionally keeps its
    // historical global Opus default unchanged.
    let collective = current_coordination_has_runtime_dialogue();
    let default_model = if config.model_routing && collective {
        None
    } else {
        Some("opus".to_string())
    };

    // The always-on audit log lives under ~/.baro/runs (not the project
    // tree) so the diagnostic trail survives checkouts, branch switches,
    // and cleanups — we once lost a run's audit data from <cwd>/.baro.
    // Pre-touch both the JSONL and the stderr sidecar so the diagnostic
    // surface exists even if the JS process dies in its first 50ms.
    let project_name = cwd
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.replace(['/', ' ', '\t', '\n'], "_"))
        .unwrap_or_else(|| "project".to_string());
    let unix_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let audit_root = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.clone())
        .join(".baro")
        .join("runs");
    let audit_log_default = audit_root.join(format!("{}-{}.jsonl", project_name, unix_secs));
    if let Some(parent) = audit_log_default.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "[baro] warning: could not create audit dir {}: {}",
                parent.display(),
                e
            );
        }
    }
    if let Err(e) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&audit_log_default)
    {
        eprintln!(
            "[baro] warning: could not touch audit log {}: {}",
            audit_log_default.display(),
            e
        );
    }
    let stderr_sidecar = audit_log_default.with_extension("stderr.txt");
    if let Err(e) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_sidecar)
    {
        eprintln!(
            "[baro] warning: could not touch stderr sidecar {}: {}",
            stderr_sidecar.display(),
            e
        );
    }

    let orch_cfg = orchestrator_client::OrchestratorConfig {
        prd_path: cwd.join("prd.json"),
        cwd,
        progressive_planning_id,
        parallel: config.parallel,
        timeout_secs: config.timeout_secs,
        override_model: config.override_model,
        default_model,
        skip_git: false,
        audit_log: Some(audit_log_default),
        with_critic: config.with_critic,
        critic_model: config.critic_model,
        with_librarian: config.with_librarian,
        with_memory: config.with_memory,
        with_sentry: config.with_sentry,
        with_surgeon: config.with_surgeon,
        surgeon_use_llm: config.surgeon_use_llm,
        surgeon_model: config.surgeon_model,
        intra_level_delay_secs: config.intra_level_delay_secs,
        llm: config.llm.as_str().to_string(),
        story_llm: config.story_llm.as_str().to_string(),
        critic_llm: config.critic_llm.as_str().to_string(),
        surgeon_llm: config.surgeon_llm.as_str().to_string(),
        openai_api_key: config.openai_api_key,
        openai_base_url: config.openai_base_url,
        effort: config.effort,
        story_model: config.story_model,
        tier_map: config.tier_map,
        openai_endpoints: config.openai_endpoints,
        conversation_context: config.conversation_context,
        echo_raw,
    };
    orchestrator_client::spawn_orchestrator(orch_cfg, exec_tx, stdin_rx);
    stdin_tx
}

/// Ask-after-planning (headless): emit the `mode_proposal` event, then block
/// for a `confirm_mode` command (≤120s). On timeout, auto-proceed with baro's
/// own proposed mode — the run must never hang waiting for a human. Returns the
/// ModeContract JSON the planner runs with.
async fn resolve_confirm_mode(contract: String) -> String {
    let view = serde_json::from_str::<ModeContractView>(&contract).unwrap_or_else(|_| {
        serde_json::from_str::<ModeContractView>(intake_runner::FALLBACK_CONTRACT)
            .expect("fallback contract is valid")
    });
    if let Ok(line) = serde_json::to_string(&serde_json::json!({
        "type": "mode_proposal",
        "data": { "mode": view.mode, "confidence": view.confidence, "reason": view.reason },
    })) {
        println!("{}", line);
    }
    let proposed = view.mode.clone();
    match StdinHub::global()
        .await_confirm(Duration::from_secs(120))
        .await
    {
        // "accept" or the proposed mode itself: keep the intake contract verbatim.
        Some(m) if m == "accept" || m == proposed => {
            eprintln!("[baro] confirm-mode: proceeding with proposed mode '{proposed}'");
            contract
        }
        Some(m) if m == "focused" || m == "sequential" || m == "parallel" => {
            eprintln!("[baro] confirm-mode: user chose '{m}' (proposed '{proposed}')");
            user_mode_contract(&m, &format!("User selected {m} mode."))
        }
        Some(other) => {
            eprintln!(
                "[baro] confirm-mode: ignoring invalid mode '{other}', using proposed '{proposed}'"
            );
            contract
        }
        None => {
            eprintln!(
                "[baro] confirm-mode: no confirmation within 120s — auto-proceeding with proposed mode '{proposed}'"
            );
            contract
        }
    }
}

/// Delete the previous word from the goal input, terminal-style: drop any
/// trailing whitespace, then the trailing run of non-whitespace characters.
fn delete_prev_word(s: &mut String) {
    let trimmed = s.trim_end();
    match trimmed.rfind(char::is_whitespace) {
        // Keep up to and including the boundary whitespace (char-boundary safe).
        Some(idx) => {
            let end = idx + trimmed[idx..].chars().next().unwrap().len_utf8();
            s.truncate(end);
        }
        None => s.clear(),
    }
}

fn message_command_line(id: &str, text: &str, message_id: Option<&str>) -> String {
    if id == app::DIALOGUE_AGENT_ID {
        serde_json::json!({
            "type": "dialogue_message",
            "message_id": message_id,
            "text": text,
        })
        .to_string()
    } else {
        serde_json::json!({
            "type": "agent_message",
            "id": id,
            "text": text,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::{
        apply_primary_provider_choice, coordination_has_runtime_dialogue, delete_prev_word,
        disable_implicit_codex_critic, fixed_mode_contract, headless_failure_reason,
        message_command_line, preferred_jigjoy_gateway_key, preferred_jigjoy_gateway_url,
        reconcile_jigjoy_phase_overrides, resolve_parallel_limit, unsupported_critic_backend, App,
        JIGJOY_CHEAP_STORY_MODEL, JIGJOY_GATEWAY_URL, JIGJOY_HEAVY_STORY_MODEL,
        JIGJOY_STRONG_MODEL,
    };

    fn deleted(input: &str) -> String {
        let mut s = input.to_string();
        delete_prev_word(&mut s);
        s
    }

    #[test]
    fn word_delete_cases() {
        assert_eq!(deleted("hello world"), "hello ");
        assert_eq!(deleted("hello world   "), "hello ");
        assert_eq!(deleted("hello"), "");
        assert_eq!(deleted(""), "");
    }

    #[test]
    fn message_command_distinguishes_collective_from_story_chat() {
        assert_eq!(
            message_command_line(crate::app::DIALOGUE_AGENT_ID, "status", Some("request-7"),),
            r#"{"message_id":"request-7","text":"status","type":"dialogue_message"}"#,
        );
        assert_eq!(
            message_command_line("S2", "run tests", None),
            r#"{"id":"S2","text":"run tests","type":"agent_message"}"#,
        );
    }

    #[test]
    fn only_collective_coordination_receives_runtime_dialogue_context() {
        assert!(coordination_has_runtime_dialogue("collective"));
        assert!(!coordination_has_runtime_dialogue("legacy"));
        assert!(!coordination_has_runtime_dialogue(""));
    }

    #[test]
    fn jigjoy_defaults_keep_planning_and_heavy_review_off_flash() {
        assert_eq!(JIGJOY_STRONG_MODEL, "glm-5.2");
        assert_eq!(JIGJOY_CHEAP_STORY_MODEL, "deepseek-v4-flash");
        assert_eq!(JIGJOY_HEAVY_STORY_MODEL, "deepseek-v4-pro");
        assert_eq!(JIGJOY_GATEWAY_URL, "https://gw.baro.jigjoy.ai/v1");
        assert_ne!(JIGJOY_STRONG_MODEL, JIGJOY_CHEAP_STORY_MODEL);
        assert_ne!(JIGJOY_HEAVY_STORY_MODEL, JIGJOY_CHEAP_STORY_MODEL);
    }

    #[test]
    fn jigjoy_key_wins_over_an_unrelated_openai_key() {
        assert_eq!(
            preferred_jigjoy_gateway_key(Some("jigjoy-token".into()), Some("openai-token".into()),)
                .as_deref(),
            Some("jigjoy-token"),
        );
        assert_eq!(
            preferred_jigjoy_gateway_key(None, Some("legacy-gateway-token".into())).as_deref(),
            Some("legacy-gateway-token"),
        );
    }

    #[test]
    fn jigjoy_url_ignores_ambient_openai_routing() {
        assert_eq!(
            preferred_jigjoy_gateway_url(None, Some("https://tenant-gateway.example/v1".into()),),
            "https://tenant-gateway.example/v1",
        );
        assert_eq!(
            preferred_jigjoy_gateway_url(
                Some("https://explicit.example/v1".into()),
                Some("https://tenant-gateway.example/v1".into()),
            ),
            "https://explicit.example/v1",
        );
        assert_eq!(preferred_jigjoy_gateway_url(None, None), JIGJOY_GATEWAY_URL);
    }

    #[test]
    fn jigjoy_phase_backend_overrides_drop_incompatible_preset_models() {
        let mut app = App::new();
        app.llm = crate::app::LlmProvider::OpenAI;
        app.architect_llm = crate::app::LlmProvider::Claude;
        app.planner_llm = crate::app::LlmProvider::Codex;
        app.story_llm = crate::app::LlmProvider::Claude;
        app.critic_llm = crate::app::LlmProvider::Claude;
        app.surgeon_llm = crate::app::LlmProvider::Claude;
        app.architect_model = Some(JIGJOY_STRONG_MODEL.into());
        app.planner_model = Some(JIGJOY_STRONG_MODEL.into());
        app.critic_model = Some(JIGJOY_HEAVY_STORY_MODEL.into());
        app.surgeon_model = Some(JIGJOY_STRONG_MODEL.into());
        app.tier_map = Some("default=openai:deepseek-v4-flash".into());

        reconcile_jigjoy_phase_overrides(&mut app, false, false, false, false, false);

        assert_eq!(app.model_for_phase("architect").as_deref(), Some("opus"));
        assert_eq!(app.model_for_phase("planning"), None);
        assert_eq!(app.critic_model, None);
        assert_eq!(app.surgeon_model, None);
        assert_eq!(app.tier_map, None);
    }

    #[test]
    fn fixed_mode_contract_is_available_before_architect() {
        assert!(fixed_mode_contract(false, "auto").is_none());

        let parallel: serde_json::Value =
            serde_json::from_str(&fixed_mode_contract(false, "parallel").unwrap()).unwrap();
        assert_eq!(parallel["mode"], "parallel");
        assert_eq!(parallel["source"], "user");
        assert!(parallel.get("parallelism").is_none());
        assert!(parallel.get("maxStories").is_none());

        let sequential: serde_json::Value =
            serde_json::from_str(&fixed_mode_contract(false, "sequential").unwrap()).unwrap();
        assert_eq!(sequential["mode"], "sequential");
        assert_eq!(sequential["parallelism"], 1);
        assert_eq!(sequential["maxStories"], 5);

        let focused: serde_json::Value =
            serde_json::from_str(&fixed_mode_contract(false, "focused").unwrap()).unwrap();
        assert_eq!(focused["mode"], "focused");
        assert_eq!(focused["parallelism"], 1);
        assert_eq!(focused["maxStories"], 1);

        // Quick is the stronger operator override even if another mode value
        // is present on the App.
        let quick: serde_json::Value =
            serde_json::from_str(&fixed_mode_contract(true, "parallel").unwrap()).unwrap();
        assert_eq!(quick["mode"], "focused");
        assert_eq!(quick["source"], "user");
        assert_eq!(quick["maxStories"], 1);
    }

    #[test]
    fn explicit_unlimited_parallel_overrides_repository_cap() {
        let omitted = crate::cli::cli::Cli::try_parse_from(["baro"]).unwrap();
        let unlimited = crate::cli::cli::Cli::try_parse_from(["baro", "--parallel", "0"]).unwrap();

        assert_eq!(omitted.parallel, None);
        assert_eq!(unlimited.parallel, Some(0));
        assert_eq!(resolve_parallel_limit(Some(4), Some(0)), 0);
        assert_eq!(resolve_parallel_limit(Some(4), None), 4);
        assert_eq!(resolve_parallel_limit(None, Some(6)), 6);
        assert_eq!(resolve_parallel_limit(None, None), 0);
    }

    #[test]
    fn enabled_codex_critic_is_rejected_before_planning() {
        assert!(
            unsupported_critic_backend(true, crate::app::LlmProvider::Codex,)
                .unwrap()
                .contains("--critic-llm")
        );
        assert!(unsupported_critic_backend(false, crate::app::LlmProvider::Codex,).is_none());
        assert!(unsupported_critic_backend(true, crate::app::LlmProvider::OpenAI,).is_none());
    }

    #[test]
    fn implicit_codex_critic_is_disabled_without_rerouting_other_phases() {
        let mut app = App::new();
        apply_primary_provider_choice(&mut app, crate::app::LlmProvider::Codex, false);

        assert!(disable_implicit_codex_critic(&mut app, false, false));
        assert!(!app.with_critic);
        assert_eq!(app.architect_llm, crate::app::LlmProvider::Codex);
        assert_eq!(app.planner_llm, crate::app::LlmProvider::Codex);
        assert_eq!(app.story_llm, crate::app::LlmProvider::Codex);
        assert_eq!(app.surgeon_llm, crate::app::LlmProvider::Codex);
        assert!(unsupported_critic_backend(app.with_critic, app.critic_llm).is_none());
    }

    #[test]
    fn explicit_codex_critic_requests_stay_enabled_and_fail_closed() {
        for (critic_requested, backend_explicit) in [(true, false), (false, true)] {
            let mut app = App::new();
            apply_primary_provider_choice(&mut app, crate::app::LlmProvider::Codex, false);

            assert!(!disable_implicit_codex_critic(
                &mut app,
                critic_requested,
                backend_explicit,
            ));
            assert!(app.with_critic);
            assert!(unsupported_critic_backend(app.with_critic, app.critic_llm).is_some());
        }
    }

    #[test]
    fn picker_preserves_an_explicit_safe_critic_backend() {
        for safe_backend in [
            crate::app::LlmProvider::Claude,
            crate::app::LlmProvider::OpenAI,
            crate::app::LlmProvider::OpenCode,
            crate::app::LlmProvider::Pi,
        ] {
            let mut app = App::new();
            app.critic_llm = safe_backend;
            apply_primary_provider_choice(&mut app, crate::app::LlmProvider::Codex, true);

            assert!(!disable_implicit_codex_critic(&mut app, false, true));
            assert!(app.with_critic);
            assert_eq!(app.critic_llm, safe_backend);
            assert!(unsupported_critic_backend(app.with_critic, app.critic_llm).is_none());
        }
    }

    #[test]
    fn failed_done_is_a_headless_process_failure() {
        let mut app = App::new();
        app.handle_event(
            serde_json::from_str(
                r#"{"type":"done","total_time_secs":7,"success":false,
                    "abort_reason":"verification failed: npm run test",
                    "verification":{"verification_id":"verify-1","status":"failed",
                    "duration_ms":12,"commands":[{"command":"npm run test",
                    "status":"failed","duration_ms":12,"tail":"tests failed"}]},
                    "stats":{"stories_completed":1,"stories_skipped":0,
                    "total_commits":1,"files_created":1,"files_modified":0}}"#,
            )
            .unwrap(),
        );

        assert_eq!(
            headless_failure_reason(&app).as_deref(),
            Some("verification failed: npm run test"),
        );
        assert_eq!(app.verification_status.as_deref(), Some("failed"));
        let evidence = app.verification.as_ref().unwrap();
        assert_eq!(evidence.verification_id, "verify-1");
        assert_eq!(evidence.commands[0].tail.as_deref(), Some("tests failed"));
    }
}
