mod app;
mod architect_runner;
mod claude_runner;
mod config;
mod constants;
mod context;
mod discovery;
mod doctor;
mod events;
mod executor;
mod git;
mod intake_runner;
mod notification;
mod orchestrator_client;
mod planner_runner;
mod screens;
mod service;
mod subprocess;
mod theme;
mod ui;
mod utils;
mod cli;
use utils::extract_json;

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
use events::BaroEvent;

fn review_stories_from_prd(prd: &executor::PrdFile) -> Vec<ReviewStory> {
    prd.user_stories
        .iter()
        .map(|s| ReviewStory {
            id: s.id.clone(),
            title: s.title.clone(),
            description: s.description.clone(),
            depends_on: s.depends_on.clone(),
            completed: s.passes,
            model: s.model.clone(),
        })
        .collect()
}

fn executor_config_from_app(app: &App) -> executor::ExecutorConfig {
    executor::ExecutorConfig {
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
    }
}

enum AppEvent {
    Baro(BaroEvent),
    Key(crossterm::event::KeyEvent),
    ContextReady(String),
    ContextError(String),
    /// Last element is the planner-stamped `executionMode` contract,
    /// carried opaquely into prd.json.
    PlanReady(Vec<ReviewStory>, String, String, String, Option<serde_json::Value>),
    /// Planner or Architect failure; second element is the persisted
    /// log path, if any.
    PlanError(String, Option<std::path::PathBuf>),
    /// Intake finished (`--mode auto`, interactive): show the ModePicker.
    IntakeReady { decision_doc: Option<String>, contract_json: String },
    RefineReady(Vec<ReviewStory>, String, String, String),
    RefineError(String),
    BranchError(String),
    /// Payload is the suffixed branch name the async git task settled
    /// on; the handler updates `app.branch_name` so the TUI shows the
    /// actual branch, not the pre-suffix name from the planner.
    BranchReady(String),
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

#[derive(serde::Deserialize)]
struct PrdOutput {
    project: String,
    #[serde(default)]
    #[serde(rename = "branchName")]
    branch_name: String,
    #[serde(default)]
    description: String,
    #[serde(rename = "userStories")]
    user_stories: Vec<PrdStoryOutput>,
    #[serde(default)]
    #[serde(rename = "executionMode")]
    execution_mode: Option<serde_json::Value>,
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

#[derive(serde::Deserialize)]
struct PrdStoryOutput {
    id: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    #[serde(rename = "dependsOn")]
    depends_on: Vec<String>,
    #[serde(default)]
    model: Option<String>,
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
    let p = |s: &str| s.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (pa, pb) = (p(a), p(b));
    for i in 0..3 {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
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
    let cache = std::path::PathBuf::from(home).join(".baro").join("update-check.json");
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
    let Ok(entry) = discovery::locate_script(&cwd, "packages/baro-orchestrator/scripts/runner.ts", "runner.mjs") else {
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
    let entry = discovery::locate_script(&cwd, "packages/baro-orchestrator/scripts/runner.ts", "runner.mjs")
        .map_err(|e| format!("could not locate the runner bundle ({e}). Reinstall: npm install -g baro-ai"))?;
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
    let status = cmd.spawn().map_err(|e| format!("failed to start login: {e}"))?.wait().await?;
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
        let exe = std::env::current_exe().map_err(|e| format!("cannot resolve baro binary: {e}"))?;
        let token = token.ok_or("--install-service needs --token <rt_…> (get one from the dashboard)")?;
        return service::install(&service::ServiceConfig { exe, token, workspace: cwd, control_url });
    }

    let entry = discovery::locate_script(&cwd, "packages/baro-orchestrator/scripts/runner.ts", "runner.mjs")
        .map_err(|e| format!("could not locate the runner bundle ({e}). Reinstall: npm install -g baro-ai"))?;

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

    println!("baro connect — starting runner (workspace: {})", cwd.display());
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
    let mut app = App::new();
    let cwd = std::fs::canonicalize(&cli.cwd)?;

    let rc = config::load_config(&cwd);

    app.parallel_limit = rc.parallel.unwrap_or(0);
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

    if cli.parallel != 0 { app.parallel_limit = cli.parallel; }
    if let Some(t) = cli.timeout { app.timeout_secs = t; }

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

    // --continue: the branch override happens in the JS orchestrator; the
    // spawned cli.mjs inherits this env var, so no config field is threaded.
    if cli.continue_run {
        std::env::set_var("BARO_CONTINUE", "1");
    }

    app.effort = cli.effort.clone();
    app.mode = cli.mode.clone();

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
            app.critic_llm = app::LlmProvider::Codex;
            app.surgeon_llm = app::LlmProvider::Claude;
        }
        "jigjoy" => {
            // Hosted preset: every phase talks to the baro gateway, an
            // OpenAI-compatible proxy that holds the upstream keys and
            // maps model names to tiers. Strong defaults to DeepSeek V4 Pro
            // while we validate cost/quality; set BARO_JIGJOY_STRONG_MODEL to
            // gpt-5.5 to opt back into OpenAI for planning/replanning.
            app.llm = app::LlmProvider::OpenAI;
            app.architect_llm = app::LlmProvider::OpenAI;
            app.planner_llm = app::LlmProvider::OpenAI;
            app.story_llm = app::LlmProvider::OpenAI;
            app.critic_llm = app::LlmProvider::OpenAI;
            app.surgeon_llm = app::LlmProvider::OpenAI;

            // Per-phase defaults only when the user didn't pin a model.
            // These are the gateway's tier tokens; env-overridable so a
            // self-hosted gateway can point them at its own models.
            let strong =
                std::env::var("BARO_JIGJOY_STRONG_MODEL").unwrap_or_else(|_| "deepseek-v4-pro".to_string());
            let cheap =
                std::env::var("BARO_JIGJOY_STORY_MODEL").unwrap_or_else(|_| "deepseek-v4-flash".to_string());
            if app.planner_model.is_none() {
                app.planner_model = Some(strong.clone());
            }
            if app.architect_model.is_none() {
                app.architect_model = Some(strong.clone());
            }
            if app.surgeon_model.is_none() {
                app.surgeon_model = Some(strong.clone());
            }
            if app.critic_model.is_none() {
                app.critic_model = Some(cheap.clone());
            }
            // Most story tiers map to the cheap model; `heavy` maps to the
            // strong route for focused/high-blast-radius work selected by the
            // Intake + Planner contract. Routing accepts the legacy
            // haiku/sonnet/opus spellings as aliases, so old PRDs still hit
            // these keys. DeepSeek Pro is cheap enough to use as the safe
            // lane while we evaluate quality.
            if app.tier_map.is_none() {
                app.tier_map = Some(format!(
                    "default=openai:{cheap},light=openai:{cheap},standard=openai:{cheap},heavy=openai:{strong}"
                ));
            }

            // Default gateway URL unless --openai-base-url / OPENAI_BASE_URL
            // is set; the env var feeds the resolution below. Override
            // per-deploy with BARO_JIGJOY_URL.
            let base_url_set = cli.openai_base_url.is_some()
                || std::env::var("OPENAI_BASE_URL")
                    .map(|v| !v.is_empty())
                    .unwrap_or(false);
            if !base_url_set {
                let url = std::env::var("BARO_JIGJOY_URL")
                    .unwrap_or_else(|_| "https://baro.jigjoy.ai/v1".to_string());
                std::env::set_var("OPENAI_BASE_URL", url);
            }

            // The hosted key arrives as JIGJOY_API_KEY; the OpenAI path reads
            // OPENAI_API_KEY, so bridge it without clobbering an explicit one.
            let openai_key_set = std::env::var("OPENAI_API_KEY")
                .map(|v| !v.is_empty())
                .unwrap_or(false);
            if !openai_key_set {
                if let Ok(k) = std::env::var("JIGJOY_API_KEY") {
                    if !k.is_empty() {
                        std::env::set_var("OPENAI_API_KEY", k);
                    }
                }
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
             Set it before running: `export OPENAI_API_KEY=sk-...`. \
             Continuing — current build silently falls through to Claude behaviour."
        );
    }

    let (tx, mut rx) = mpsc::channel::<AppEvent>(256);

    // Resume detection: check for existing prd.json with incomplete stories
    let prd_path = cwd.join("prd.json");
    let mut entered_resume = false;
    if prd_path.exists() {
        if let Ok(prd_contents) = std::fs::read_to_string(&prd_path) {
            if let Ok(prd) = serde_json::from_str::<executor::PrdFile>(&prd_contents) {
                let has_incomplete = prd.user_stories.iter().any(|s| !s.passes);
                if cli.resume || (has_incomplete && cli.goal.is_none()) {
                    app.is_resume = true;
                    app.project = prd.project.clone();
                    app.branch_name = prd.branch_name.clone();
                    app.description = prd.description.clone();
                    let stories = review_stories_from_prd(&prd);
                    app.show_review(stories);
                    entered_resume = true;
                }
            }
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

    // CLI goal (not resuming): skip welcome and start planning.
    // No goal: start at the ProviderPicker unless --llm was explicit.
    if !entered_resume {
        if let Some(goal) = cli.goal {
            app.goal_input = goal;
            // CLI-goal + openai + no key → detour through ApiKeyInput;
            // its Enter handler sees `goal_input` set and jumps straight
            // to planning, so the user never goes through Welcome.
            if app.llm == app::LlmProvider::OpenAI && app.openai_api_key.is_none() {
                if headless {
                    return Err("--headless with --llm openai requires OPENAI_API_KEY".into());
                }
                app.screen = app::Screen::ApiKeyInput;
                app.api_key_input.clear();
            } else {
                let claude_md_path = cwd.join("CLAUDE.md");
                if claude_md_path.exists() {
                    if let Ok(content) = std::fs::read_to_string(&claude_md_path) {
                        ensure_agents_md_mirror(&cwd, &content);
                        app.claude_md_content = Some(content);
                    }
                    app.start_planning();
                    spawn_planner(&app, &cwd, tx.clone(), headless);
                } else {
                    app.start_context();
                    spawn_context_builder(&cwd, tx.clone());
                }
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
                app.screen = app::Screen::Welcome;
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
                        if tx_key.blocking_send(AppEvent::Key(key)).is_err() { break; }
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
            if tx_tick.send(AppEvent::Tick).await.is_err() { break; }
        }
    });

    // Throttle drawing to ~30fps: the orchestrator floods the channel with
    // log events, and drawing per event pegs the CPU and starves keyboard
    // input. Events still apply immediately; the 100ms tick guarantees an
    // idle refresh so the final frame after a burst is at most a tick late.
    let mut last_draw = Instant::now()
        .checked_sub(Duration::from_millis(100))
        .unwrap_or_else(Instant::now);
    let mut stdin_forwarder_started = false;
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
                let is_exit = matches!(ev, BaroEvent::OrchestratorExited { .. });
                let story_start_id = if let BaroEvent::StoryStart { ref id, .. } = ev {
                    Some(id.clone())
                } else {
                    None
                };
                app.handle_event(ev);
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
                            let visible = t.size().map(|s| s.height.saturating_sub(10)).unwrap_or(20);
                            app.dag_auto_scroll_to_story(sid, visible);
                        }
                    }
                }
            }
            Some(AppEvent::ContextReady(content)) => {
                app.claude_md_content = Some(content);
                app.start_planning();
                spawn_planner(&app, &cwd, tx.clone(), headless);
            }
            Some(AppEvent::ContextError(err)) => {
                if headless {
                    return Err(format!("context build failed: {}", err).into());
                }
                app.planning_error = Some(err);
            }
            Some(AppEvent::PlanReady(stories, project, branch, description, execution_mode)) => {
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
            Some(AppEvent::IntakeReady { decision_doc, contract_json }) => {
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
            Some(AppEvent::PlanError(err, log_path)) => {
                if headless {
                    return Err(format!("planning failed: {}", err).into());
                }
                app.planning_error = Some(err);
                app.planning_log_path = log_path;
            }
            Some(AppEvent::RefineReady(stories, project, branch, description)) => {
                app.refining = false;
                app.project = project;
                app.branch_name = branch;
                app.description = description;
                app.show_review(stories);
            }
            Some(AppEvent::RefineError(err)) => {
                app.refining = false;
                app.planning_error = Some(err);
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
                app.architect_status = app::ArchitectStatus::Skipped(reason);
                app.decision_document = None;
            }
            Some(AppEvent::BranchError(err)) => {
                if headless {
                    return Err(format!("branch/exec failed: {}", err).into());
                }
                app.planning_error = Some(err);
                app.screen = Screen::Review;
            }
            Some(AppEvent::BranchReady(name)) => {
                app.branch_name = name;
            }
            Some(AppEvent::Key(key)) => {
                // Keys only arrive in TUI mode; rebind `terminal` to the
                // real handle so the screen handlers below are unchanged.
                let Some(terminal) = terminal.as_deref_mut() else { continue };
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
                                app.provider_picker_index = app.provider_picker_options.len().saturating_sub(1);
                            }
                        }
                        KeyCode::Down | KeyCode::Char('j') => {
                            if app.provider_picker_index < app.provider_picker_options.len().saturating_sub(1) {
                                app.provider_picker_index += 1;
                            } else {
                                app.provider_picker_index = 0;
                            }
                        }
                        KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                            let chosen = app.provider_picker_options[app.provider_picker_index];
                            app.llm = chosen;
                            app.architect_llm = chosen;
                            app.planner_llm = chosen;
                            app.story_llm = chosen;
                            app.critic_llm = chosen;
                            app.surgeon_llm = chosen;
                            // Set the legacy planner enum to match
                            app.planner = match chosen {
                                app::LlmProvider::Claude => app::Planner::Claude,
                                app::LlmProvider::OpenAI => app::Planner::OpenAI,
                                app::LlmProvider::Codex => app::Planner::Codex,
                                app::LlmProvider::OpenCode => app::Planner::OpenCode,
                                app::LlmProvider::Pi => app::Planner::Pi,
                            };
                            // OpenAI needs an API key — detour if missing
                            if chosen == app::LlmProvider::OpenAI && app.openai_api_key.is_none() {
                                app.api_key_input.clear();
                                app.screen = Screen::ApiKeyInput;
                            } else {
                                app.screen = Screen::Welcome;
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
                                // A CLI goal means "what should I do" is
                                // already answered — jump straight to
                                // planning instead of Welcome.
                                if !app.goal_input.is_empty() {
                                    let claude_md_path = cwd.join("CLAUDE.md");
                                    if claude_md_path.exists() {
                                        if let Ok(content) = std::fs::read_to_string(&claude_md_path) {
                                            ensure_agents_md_mirror(&cwd, &content);
                                            app.claude_md_content = Some(content);
                                        }
                                        app.start_planning();
                                        spawn_planner(&app, &cwd, tx.clone(), headless);
                                    } else {
                                        app.start_context();
                                        spawn_context_builder(&cwd, tx.clone());
                                    }
                                } else {
                                    app.screen = Screen::Welcome;
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
                        KeyCode::Tab => { app.welcome_field = app.welcome_field.next(); }
                        KeyCode::BackTab => { app.welcome_field = app.welcome_field.prev(); }
                        KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                            if app.welcome_field != app::WelcomeField::Goal {
                                // Enter on non-goal fields = jump to goal
                                app.welcome_field = app::WelcomeField::Goal;
                            } else if !app.goal_input.is_empty() {
                                let claude_md_path = cwd.join("CLAUDE.md");
                                if claude_md_path.exists() {
                                    if let Ok(content) = std::fs::read_to_string(&claude_md_path) {
                                        ensure_agents_md_mirror(&cwd, &content);
                                        app.claude_md_content = Some(content);
                                    }
                                    app.start_planning();
                                    spawn_planner(&app, &cwd, tx.clone(), headless);
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
                                    let options: &[Option<&str>] = &[None, Some("opus"), Some("sonnet"), Some("haiku")];
                                    let current = options.iter().position(|o| {
                                        match (&app.override_model, o) {
                                            (None, None) => app.model_routing,
                                            (Some(m), Some(o)) => m.as_str() == *o,
                                            _ => false,
                                        }
                                    }).unwrap_or(0);
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
                                        app.timeout_secs = app.timeout_secs.saturating_sub(60).max(60);
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
                                spawn_planner(&app, &cwd, tx.clone(), headless);
                            }
                        }
                        _ => {}
                    },
                    Screen::Review => if app.refine_input.is_some() {
                        // Overlay is open — handle overlay keys only
                        match key.code {
                            KeyCode::Esc => { app.refine_input = None; }
                            KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                                let feedback = app.refine_input.as_ref().unwrap().clone();
                                if !feedback.is_empty() {
                                    app.refining = true;
                                    app.refine_input = None;
                                    spawn_refiner(&app, &feedback, &cwd, tx.clone());
                                }
                            }
                            KeyCode::Char(c) => { app.refine_input.as_mut().unwrap().push(c); }
                            KeyCode::Backspace => { app.refine_input.as_mut().unwrap().pop(); }
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
                        KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                            if app.is_resume {
                                // Resume mode: read existing prd.json (has full acceptance/tests data)
                                let prd_path = cwd.join("prd.json");
                                match std::fs::read_to_string(&prd_path)
                                    .map_err(|e| e.to_string())
                                    .and_then(|c| serde_json::from_str::<executor::PrdFile>(&c).map_err(|e| e.to_string()))
                                {
                                    Ok(prd) => {
                                        // prd.json holds either the full "baro/<slug>-<suffix>"
                                        // name or (legacy) the bare slug — prefix only when missing.
                                        let full_branch = if prd.branch_name.starts_with("baro/") {
                                            prd.branch_name.clone()
                                        } else {
                                            format!("baro/{}", prd.branch_name)
                                        };
                                        let branch_cwd = cwd.clone();
                                        let branch_name_clone = full_branch.clone();
                                        app.branch_name = full_branch;
                                        app.start_execution();
                                        let exec_cwd = cwd.clone();
                                        let branch_tx = tx.clone();
                                        let mr = app.model_routing;
                                        let om = app.override_model.clone();
                                        let pl = app.parallel_limit;
                                        let ts = app.timeout_secs;
                                        let wc = app.with_critic;
                                        let cm = app.critic_model.clone();
                                        let wl = app.with_librarian;
                                        let wmem = app.with_memory;
                                        let ws = app.with_sentry;
                                        let wsg = app.with_surgeon;
                                        let sul = app.surgeon_use_llm;
                                        let sm = app.surgeon_model.clone();
                                        let ild = app.intra_level_delay_secs;
                                        let llm = app.llm;
                                        let sllm = app.story_llm;
                                        let cllm = app.critic_llm;
                                        let surllm = app.surgeon_llm;
                                        let oak = app.openai_api_key.clone();
                                        let obu = app.openai_base_url.clone();
                                        let eff = app.effort.clone();
                                        let stm = app.story_model.clone();
                                        let ttm = app.tier_map.clone();
                                        let oep = app.openai_endpoints.clone();
                                        let err_tx = tx.clone();
                                        tokio::spawn(async move {
                                            // Resume: check out the suffixed branch prd.json
                                            // holds — never create a new one (that would
                                            // silently drift off the prior work).
                                            if let Err(e) = git::checkout_existing_branch(&branch_cwd, &branch_name_clone).await {
                                                let _ = err_tx.send(AppEvent::BranchError(
                                                    format!("Branch checkout failed: {}. Cannot resume run on this branch.", e)
                                                )).await;
                                                return;
                                            }
                                            match git::get_current_branch(&exec_cwd).await {
                                                Ok(ref actual) if actual == &branch_name_clone => {}
                                                Ok(actual) => {
                                                    let _ = err_tx.send(AppEvent::BranchError(
                                                        format!("Branch verification failed: expected '{}', got '{}'. Cannot proceed on main branch.", branch_name_clone, actual)
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
                                            spawn_executor(prd, exec_cwd, branch_tx, executor::ExecutorConfig { parallel: pl, timeout_secs: ts, model_routing: mr, override_model: om, with_critic: wc, critic_model: cm, with_librarian: wl, with_memory: wmem, with_sentry: ws, with_surgeon: wsg, surgeon_use_llm: sul, surgeon_model: sm, intra_level_delay_secs: ild, llm, story_llm: sllm, critic_llm: cllm, surgeon_llm: surllm, openai_api_key: oak.clone(), openai_base_url: obu.clone(), effort: eff.clone(), story_model: stm.clone(), tier_map: ttm.clone(), openai_endpoints: oep.clone() }, false);
                                        });
                                    }
                                    Err(e) => {
                                        app.planning_error = Some(format!("Failed to read prd.json: {}", e));
                                    }
                                }
                            } else {
                                let prd = executor::prd_from_review(
                                    &app.project,
                                    &app.branch_name,
                                    &app.description,
                                    &app.review_stories,
                                    app.decision_document.clone(),
                                    app.execution_mode.clone(),
                                );
                                if let Err(e) = executor::write_prd(&prd, &cwd) {
                                    app.planning_error = Some(format!("Failed to write prd.json: {}", e));
                                } else {
                                    let full_branch = if app.branch_name.starts_with("baro/") {
                                        app.branch_name.clone()
                                    } else {
                                        format!("baro/{}", app.branch_name)
                                    };
                                    let branch_cwd = cwd.clone();
                                    let branch_name_clone = full_branch.clone();
                                    app.branch_name = full_branch;
                                    app.start_execution();
                                    let exec_prd = prd;
                                    let exec_cwd = cwd.clone();
                                    let branch_tx = tx.clone();
                                    let is_followup = app.is_followup;
                                    let mr = app.model_routing;
                                    let om = app.override_model.clone();
                                    let pl = app.parallel_limit;
                                    let ts = app.timeout_secs;
                                    let wc = app.with_critic;
                                    let cm = app.critic_model.clone();
                                    let wl = app.with_librarian;
                                    let wmem = app.with_memory;
                                    let ws = app.with_sentry;
                                    let wsg = app.with_surgeon;
                                    let sul = app.surgeon_use_llm;
                                    let sm = app.surgeon_model.clone();
                                    let ild = app.intra_level_delay_secs;
                                    let llm = app.llm;
                                    let sllm = app.story_llm;
                                    let cllm = app.critic_llm;
                                    let surllm = app.surgeon_llm;
                                    let oak = app.openai_api_key.clone();
                                    let obu = app.openai_base_url.clone();
                                    let eff = app.effort.clone();
                                    let stm = app.story_model.clone();
                                    let ttm = app.tier_map.clone();
                                    let oep = app.openai_endpoints.clone();
                                    let err_tx = tx.clone();
                                    tokio::spawn(async move {
                                        // Follow-up (--continue): stay on the current branch
                                        // so it lands on the same PR. Otherwise ALWAYS cut a
                                        // fresh suffixed branch — sibling clones sharing an
                                        // origin would collide on `git push`.
                                        let actual_full_branch = if is_followup {
                                            match git::get_current_branch(&branch_cwd).await {
                                                Ok(name) => name,
                                                Err(e) => {
                                                    let _ = err_tx.send(AppEvent::BranchError(
                                                        format!("Couldn't read current branch for follow-up: {}", e)
                                                    )).await;
                                                    return;
                                                }
                                            }
                                        } else {
                                            match git::create_fresh_branch(&branch_cwd, &branch_name_clone).await {
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
                                        if let Err(e) = executor::write_prd(&exec_prd, &exec_cwd) {
                                            let _ = err_tx.send(AppEvent::BranchError(
                                                format!("Failed to persist suffixed branch in prd.json: {}", e)
                                            )).await;
                                            return;
                                        }
                                        let _ = err_tx.send(AppEvent::BranchReady(actual_full_branch.clone())).await;
                                        match git::get_current_branch(&exec_cwd).await {
                                            Ok(ref actual) if actual == &actual_full_branch => {}
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
                                        spawn_executor(exec_prd, exec_cwd, branch_tx, executor::ExecutorConfig { parallel: pl, timeout_secs: ts, model_routing: mr, override_model: om, with_critic: wc, critic_model: cm, with_librarian: wl, with_memory: wmem, with_sentry: ws, with_surgeon: wsg, surgeon_use_llm: sul, surgeon_model: sm, intra_level_delay_secs: ild, llm, story_llm: sllm, critic_llm: cllm, surgeon_llm: surllm, openai_api_key: oak.clone(), openai_base_url: obu.clone(), effort: eff.clone(), story_model: stm.clone(), tier_map: ttm.clone(), openai_endpoints: oep.clone() }, false);
                                    });
                                }
                            }
                        }
                        KeyCode::Up | KeyCode::Char('k') => app.review_prev(),
                        KeyCode::Down | KeyCode::Char('j') => app.review_next(),
                        _ => {}
                    }},
                    Screen::Execute => match key.code {
                        // Follow-up prompt (open after a successful run): type a new goal,
                        // Enter re-plans on the SAME branch (--continue → updates the PR).
                        KeyCode::Esc if app.followup_input.is_some() => {
                            app.followup_input = None;
                        }
                        KeyCode::Backspace if app.followup_input.is_some() => {
                            if let Some(s) = app.followup_input.as_mut() {
                                s.pop();
                            }
                        }
                        KeyCode::Char(c) if app.followup_input.is_some() => {
                            if let Some(s) = app.followup_input.as_mut() {
                                s.push(c);
                            }
                        }
                        KeyCode::Enter if app.followup_input.is_some() => {
                            let goal = app.followup_input.take().unwrap_or_default();
                            if !goal.trim().is_empty() {
                                std::env::set_var("BARO_CONTINUE", "1");
                                app.is_followup = true;
                                app.goal_input = goal;
                                app.start_planning();
                                spawn_planner(&app, &cwd, tx.clone(), headless);
                            }
                        }
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
                                    if let Some(sender) = &app.orchestrator_stdin {
                                        let line = serde_json::json!({
                                            "type": "agent_message",
                                            "id": id,
                                            "text": text,
                                        })
                                        .to_string();
                                        let _ = sender.try_send(line);
                                    }
                                    app.echo_user_message(&id, &text);
                                }
                            }
                        }
                        // Follow-up works on the current branch via --continue, with or
                        // without a PR — don't gate on pr_url (local/no-remote runs can
                        // still continue the run in place).
                        KeyCode::Char('f') if app.done && app.exit_reason.is_none() && app.followup_input.is_none() => {
                            app.followup_input = Some(String::new());
                        }
                        KeyCode::Char('m') if !app.done && app.followup_input.is_none() => {
                            if let Some(id) = app.message_target() {
                                app.agent_msg_input = Some((id, String::new()));
                            }
                        }
                        KeyCode::Char('r') if app.done && app.exit_reason.is_some() => {
                            let prd_path = cwd.join("prd.json");
                            match std::fs::read_to_string(&prd_path)
                                .map_err(|e| e.to_string())
                                .and_then(|c| serde_json::from_str::<executor::PrdFile>(&c).map_err(|e| e.to_string()))
                            {
                                Ok(prd) => {
                                    let full_branch = if prd.branch_name.starts_with("baro/") {
                                        prd.branch_name.clone()
                                    } else {
                                        format!("baro/{}", prd.branch_name)
                                    };
                                    app.is_resume = true;
                                    app.project = prd.project.clone();
                                    app.branch_name = full_branch.clone();
                                    app.description = prd.description.clone();
                                    app.review_stories = review_stories_from_prd(&prd);
                                    app.start_execution();

                                    let exec_cwd = cwd.clone();
                                    let branch_cwd = cwd.clone();
                                    let branch_tx = tx.clone();
                                    let err_tx = tx.clone();
                                    let cfg = executor_config_from_app(&app);
                                    tokio::spawn(async move {
                                        if let Err(e) = git::checkout_existing_branch(&branch_cwd, &full_branch).await {
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
                                        spawn_executor(prd, exec_cwd, branch_tx, cfg, false);
                                    });
                                }
                                Err(e) => {
                                    app.exit_reason = Some(format!("Failed to read prd.json for rerun: {}", e));
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
                            let explorer_shown = app.explorer_visible
                                && width >= screens::execute::BP_EXPLORER;
                            if explorer_shown {
                                app.focus = if back { app.focus.prev() } else { app.focus.next() };
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
                                    let inner_h = terminal.size().map(|s| s.height.saturating_sub(12) as usize).unwrap_or(20);
                                    let active_ids = app.active_story_ids();
                                    let selected_id = app
                                        .activity_filter
                                        .clone()
                                        .or_else(|| active_ids.get(app.selected_log_index).cloned())
                                        .unwrap_or_default();
                                    if !app.review_logs.is_empty() && active_ids.is_empty() {
                                        let total = app.review_logs.len();
                                        app.review_log_scroll_up(1, total, inner_h);
                                    } else if let Some(story) = app.active_stories.get(&selected_id) {
                                        let total = if story.activity.is_empty() { story.logs.len() } else { story.activity.len() };
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
                        KeyCode::Down | KeyCode::Char('j') => match effective_focus(&app, terminal) {
                            app::WorkbenchFocus::Agents => app.explorer_agents_move(1),
                            app::WorkbenchFocus::Changes => app.explorer_files_move(1),
                            app::WorkbenchFocus::Main => match app.main_view {
                                app::MainView::Activity => {
                                    let inner_h = terminal.size().map(|s| s.height.saturating_sub(12) as usize).unwrap_or(20);
                                    let active_ids = app.active_story_ids();
                                    let selected_id = app
                                        .activity_filter
                                        .clone()
                                        .or_else(|| active_ids.get(app.selected_log_index).cloned())
                                        .unwrap_or_default();
                                    if !app.review_logs.is_empty() && active_ids.is_empty() {
                                        let total = app.review_logs.len();
                                        app.review_log_scroll_down(1, total, inner_h);
                                    } else if let Some(story) = app.active_stories.get(&selected_id) {
                                        let total = if story.activity.is_empty() { story.logs.len() } else { story.activity.len() };
                                        app.log_scroll_down(1, total, inner_h);
                                    }
                                }
                                app::MainView::Plan => {
                                    let total = app.dag_line_count();
                                    let visible = terminal.size().map(|s| s.height.saturating_sub(10)).unwrap_or(20);
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
                // Headless: our own stdin is the cloud→run command lane.
                // A plain std thread (like the keyboard reader) so a
                // forever-blocked read can't stall runtime shutdown; send
                // errors after child exit just end the thread.
                if headless && !stdin_forwarder_started {
                    stdin_forwarder_started = true;
                    let cmd_tx = sender.clone();
                    std::thread::spawn(move || {
                        use std::io::BufRead;
                        for line in std::io::stdin().lock().lines() {
                            let Ok(line) = line else { break };
                            if let Some(cmd) = stdin_command_line(&line) {
                                if cmd_tx.blocking_send(cmd).is_err() {
                                    break;
                                }
                            }
                        }
                    });
                }
                app.orchestrator_stdin = Some(sender);
            }
            Some(AppEvent::Tick) => {
                app.tick_count += 1;
            }
            None => break,
        }
    }
    Ok(())
}

/// Stage A of planning: Architect, then execution-mode contract
/// resolution. `--mode auto` runs the intake; interactively that pauses
/// at the ModePicker (IntakeReady) and stage B is spawned on confirm,
/// otherwise the flow continues straight into the planner.
fn spawn_planner(app: &App, cwd: &Path, tx: mpsc::Sender<AppEvent>, headless: bool) {
    let goal = app.goal_input.clone();
    let planner = app.planner;
    let cwd = cwd.to_path_buf();
    let model = app.model_for_phase("planning");
    let architect_model = app.model_for_phase("architect");
    let context = app.claude_md_content.clone();
    let quick = app.quick;
    let mode = app.mode.clone();
    // Per-phase routing lets hybrid runs split Architect/Planner from
    // Story/Critic/Surgeon; unset overrides fall back to the global --llm.
    let architect_llm = app.architect_llm;
    let planner_llm = app.planner_llm;
    let openai_api_key = app.openai_api_key.clone();
    let openai_base_url = app.openai_base_url.clone();
    let effort = app.effort.clone();

    tokio::spawn(async move {
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
                openai_api_key.as_deref(),
                openai_base_url.as_deref(),
                &effort,
            ).await {
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
        let mode_json = if quick {
            Some(user_mode_contract("focused", "Quick mode"))
        } else if mode != "auto" {
            Some(user_mode_contract(&mode, &format!("User selected {} mode.", mode)))
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
            ).await;
            if headless {
                Some(contract)
            } else {
                let _ = tx
                    .send(AppEvent::IntakeReady { decision_doc, contract_json: contract })
                    .await;
                return;
            }
        };

        run_planner_and_report(
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
            tx,
        )
        .await;
    });
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
            goal,
            cwd,
            planner_llm,
            model,
            context,
            decision_doc,
            false, // the picker never shows in quick mode
            openai_api_key,
            openai_base_url,
            effort,
            Some(mode_json),
            tx,
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
            "parallelism": 4, "source": "user",
        }),
        _ => serde_json::json!({
            "mode": "focused", "confidence": 1, "reason": reason,
            "maxStories": 1, "parallelism": 1, "source": "user",
        }),
    };
    v.to_string()
}

#[allow(clippy::too_many_arguments)]
async fn run_planner_and_report(
    goal: String,
    cwd: PathBuf,
    planner_llm: app::LlmProvider,
    model: Option<String>,
    context: Option<String>,
    decision_doc: Option<String>,
    quick: bool,
    openai_api_key: Option<String>,
    openai_base_url: Option<String>,
    effort: String,
    mode_json: Option<String>,
    tx: mpsc::Sender<AppEvent>,
) {
    let result = planner_runner::run_planner(
        &goal,
        &cwd,
        planner_llm,
        model.as_deref(),
        context.as_deref(),
        decision_doc.as_deref(),
        quick,
        openai_api_key.as_deref(),
        openai_base_url.as_deref(),
        &effort,
        mode_json.as_deref(),
    ).await;

    match result.and_then(|raw_json| {
        let prd: PrdOutput = serde_json::from_str(&raw_json).map_err(|e| {
            subprocess::ProcessRunError {
                message: format!(
                    "Failed to parse PRD JSON from planner: {}\nRaw (first 500 chars): {}",
                    e,
                    &raw_json[..raw_json.len().min(500)],
                ),
                log_path: None,
            }
        })?;
        let stories: Vec<ReviewStory> = prd.user_stories
            .into_iter()
            .map(|s| ReviewStory {
                id: s.id,
                title: s.title,
                description: s.description,
                depends_on: s.depends_on,
                completed: false,
                model: s.model,
            })
            .collect();
        Ok((stories, prd.project, prd.branch_name, prd.description, prd.execution_mode))
    }) {
        Ok((stories, project, branch, description, execution_mode)) => {
            let _ = tx
                .send(AppEvent::PlanReady(stories, project, branch, description, execution_mode))
                .await;
        }
        Err(err) => {
            let _ = tx
                .send(AppEvent::PlanError(err.message.clone(), err.log_path))
                .await;
        }
    }
}

/// Mirror CLAUDE.md into AGENTS.md so backends following that
/// convention (OpenAI Codex CLI) see the same project context. Never
/// overwrites an existing AGENTS.md; write errors are silently
/// ignored — CLAUDE.md stays authoritative.
fn ensure_agents_md_mirror(cwd: &Path, content: &str) {
    let agents_md_path = cwd.join("AGENTS.md");
    if agents_md_path.exists() {
        return;
    }
    let _ = std::fs::write(&agents_md_path, content);
}

fn spawn_context_builder(cwd: &Path, tx: mpsc::Sender<AppEvent>) {
    let cwd = cwd.to_path_buf();
    tokio::spawn(async move {
        match context::build_context(&cwd).await {
            Ok(content) => {
                let claude_md_path = cwd.join("CLAUDE.md");
                if let Err(e) = tokio::fs::write(&claude_md_path, &content).await {
                    let _ = tx.send(AppEvent::ContextError(format!("Failed to write CLAUDE.md: {}", e))).await;
                    return;
                }
                // Mirror the same bytes to AGENTS.md for backends that
                // follow that convention. Soft-fail: CLAUDE.md is already
                // written, so the Claude path still works.
                let agents_md_path = cwd.join("AGENTS.md");
                if let Err(e) = tokio::fs::write(&agents_md_path, &content).await {
                    let _ = tx
                        .send(AppEvent::ContextError(format!(
                            "Failed to write AGENTS.md (CLAUDE.md still wrote OK): {}",
                            e
                        )))
                        .await;
                }
                let _ = tx.send(AppEvent::ContextReady(content)).await;
            }
            Err(e) => {
                let _ = tx.send(AppEvent::ContextError(format!("Failed to build context: {}", e))).await;
            }
        }
    });
}

fn spawn_refiner(app: &App, feedback: &str, cwd: &Path, tx: mpsc::Sender<AppEvent>) {
    let feedback = feedback.to_string();
    let cwd = cwd.to_path_buf();
    let model = app.model_for_phase("planning");
    let effort = app.effort.clone();
    let context = app.claude_md_content.clone();

    // Build current plan JSON from app state
    let stories_json: Vec<serde_json::Value> = app.review_stories.iter().map(|s| {
        serde_json::json!({
            "id": s.id,
            "title": s.title,
            "description": s.description,
            "dependsOn": s.depends_on,
        })
    }).collect();
    let plan_json = serde_json::json!({
        "project": app.project,
        "branchName": app.branch_name,
        "description": app.description,
        "userStories": stories_json,
    });
    let plan_str = serde_json::to_string_pretty(&plan_json).unwrap_or_default();

    tokio::spawn(async move {
        let base_prompt = format!(
            "Here is the current plan:\n{}\nThe user wants these changes: {}\nGenerate an updated plan with the same JSON schema. Keep stories the user did not mention unchanged. Output ONLY valid JSON, no markdown, no explanation.",
            plan_str, feedback
        );
        let prompt = match context {
            Some(ctx) => format!("Here is the project context:\n{}\n\n{}", ctx, base_prompt),
            None => base_prompt,
        };

        let result = async {
            let config = claude_runner::ClaudeRunConfig {
                prompt: prompt.clone(),
                cwd: cwd.clone(),
                model: model.clone(),
                effort: effort.clone(),
                log_tag: Some("refine"),
            };

            let output = claude_runner::spawn_claude_json(&config).await?;

            let claude_output: serde_json::Value = serde_json::from_str(&output.stdout)
                .map_err(|e| format!("Failed to parse Claude JSON wrapper: {}", e))?;

            let plan_text = claude_output
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or(&output.stdout);

            let json_str = extract_json(plan_text);

            let prd: PrdOutput = serde_json::from_str(&json_str)
                .map_err(|e| format!("Failed to parse refined PRD JSON: {}\nRaw: {}", e, &json_str[..json_str.len().min(500)]))?;

            let stories: Vec<ReviewStory> = prd.user_stories
                .into_iter()
                .map(|s| ReviewStory {
                    id: s.id,
                    title: s.title,
                    description: s.description,
                    depends_on: s.depends_on,
                    completed: false,
                    model: s.model,
                })
                .collect();

            Ok::<_, Box<dyn std::error::Error + Send + Sync>>((stories, prd.project, prd.branch_name, prd.description))
        }.await;

        match result {
            Ok((stories, project, branch, description)) => {
                let _ = tx.send(AppEvent::RefineReady(stories, project, branch, description)).await;
            }
            Err(e) => {
                let _ = tx.send(AppEvent::RefineError(e.to_string())).await;
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
    let prd = executor::prd_from_review(
        &app.project,
        &app.branch_name,
        &app.description,
        &app.review_stories,
        app.decision_document.clone(),
        app.execution_mode.clone(),
    );
    if let Err(e) = executor::write_prd(&prd, cwd) {
        let _ = tx.try_send(AppEvent::BranchError(format!("Failed to write prd.json: {}", e)));
        return;
    }
    let full_branch = format!("baro/{}", app.branch_name);
    app.branch_name = full_branch.clone();
    app.start_execution();
    let cfg = executor_config_from_app(app);
    let exec_cwd = cwd.to_path_buf();
    let branch_cwd = cwd.to_path_buf();
    tokio::spawn(async move {
        let actual_full_branch = match git::create_fresh_branch(&branch_cwd, &full_branch).await {
            Ok(name) => name,
            Err(e) => {
                let _ = tx
                    .send(AppEvent::BranchError(format!("Branch creation failed: {}", e)))
                    .await;
                return;
            }
        };
        let mut exec_prd = prd;
        exec_prd.branch_name = actual_full_branch;
        if let Err(e) = executor::write_prd(&exec_prd, &exec_cwd) {
            let _ = tx
                .send(AppEvent::BranchError(format!("Failed to persist branch in prd.json: {}", e)))
                .await;
            return;
        }
        spawn_executor(exec_prd, exec_cwd, tx, cfg, true);
    });
}

fn spawn_executor(
    _prd: executor::PrdFile,
    cwd: PathBuf,
    tx: mpsc::Sender<AppEvent>,
    config: executor::ExecutorConfig,
    echo_raw: bool,
) {
    // Bridge the orchestrator's BaroEvents to AppEvent::Baro so
    // app/screens stay untouched.
    let (exec_tx, mut exec_rx) = mpsc::channel::<BaroEvent>(256);

    // TUI→orchestrator command lane (agent chat): hand the app loop the
    // sender, the child-stdin writer consumes the receiver.
    let (stdin_tx, stdin_rx) = mpsc::channel::<String>(64);
    let _ = tx.try_send(AppEvent::OrchestratorStdin(stdin_tx));

    let tx_fwd = tx.clone();
    tokio::spawn(async move {
        while let Some(ev) = exec_rx.recv().await {
            if tx_fwd.send(AppEvent::Baro(ev)).await.is_err() {
                break;
            }
        }
    });

    let default_model = if config.model_routing {
        Some("opus".to_string())
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
        .map(PathBuf::from)
        .unwrap_or_else(|| cwd.clone())
        .join(".baro")
        .join("runs");
    let audit_log_default =
        audit_root.join(format!("{}-{}.jsonl", project_name, unix_secs));
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
        echo_raw,
    };
    orchestrator_client::spawn_orchestrator(orch_cfg, exec_tx, stdin_rx);
}

/// Headless command lane: keep a stdin line only if it's a JSON object
/// with a "type" field — anything else is dropped silently.
fn stdin_command_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    v.get("type")?;
    Some(trimmed.to_string())
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

#[cfg(test)]
mod tests {
    use super::{delete_prev_word, stdin_command_line};

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
    fn stdin_command_line_cases() {
        let msg = r#"{"type":"agent_message","id":"S2","text":"hi"}"#;
        assert_eq!(stdin_command_line(msg).as_deref(), Some(msg));
        // Trimmed before forwarding.
        assert_eq!(stdin_command_line(&format!("  {msg}  ")).as_deref(), Some(msg));
        assert_eq!(stdin_command_line(""), None);
        assert_eq!(stdin_command_line("   "), None);
        assert_eq!(stdin_command_line("not json"), None);
        assert_eq!(stdin_command_line(r#"{"id":"S2"}"#), None); // no "type"
        assert_eq!(stdin_command_line(r#"["type"]"#), None); // not an object
    }
}
