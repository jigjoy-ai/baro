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
mod notification;
mod orchestrator_client;
mod planner_runner;
mod screens;
mod subprocess;
mod theme;
mod ui;
mod utils;

use utils::extract_json;

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::Parser;

/// Guard that holds a session lock file and removes it on drop.
struct SessionLock {
    path: PathBuf,
}

impl SessionLock {
    fn acquire(cwd: &Path) -> Result<Self, String> {
        let lock_path = cwd.join("baro.lock");

        if lock_path.exists() {
            if let Ok(contents) = std::fs::read_to_string(&lock_path) {
                if let Ok(pid) = contents.trim().parse::<u32>() {
                    if is_process_alive(pid) {
                        return Err(
                            "Another baro session is active in this directory. Multiple sessions per project coming soon.".to_string()
                        );
                    }
                }
            }
            // Stale lock file — overwrite below
        }

        std::fs::write(&lock_path, std::process::id().to_string())
            .map_err(|e| format!("Failed to create lock file: {}", e))?;

        Ok(SessionLock { path: lock_path })
    }
}

impl Drop for SessionLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_process_alive(_pid: u32) -> bool {
    // On non-Unix platforms, assume stale lock
    false
}
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

#[derive(Parser)]
#[command(
    name = "baro",
    version,
    about = "AI-powered project execution",
    after_help = "Issues:  https://github.com/jigjoy-ai/baro/issues\nTwitter: @lotus_sbc",
)]
struct Cli {
    /// Project goal (if omitted, shows welcome screen)
    goal: Option<String>,

    /// Planner to use
    #[arg(long, default_value = "claude", value_parser = ["claude", "openai"])]
    planner: String,

    /// Working directory
    #[arg(long, default_value = ".")]
    cwd: String,

    /// Resume execution from existing prd.json
    #[arg(long)]
    resume: bool,

    /// Max parallel story executors (0 = unlimited)
    #[arg(long, default_value = "0")]
    parallel: u32,

    /// Per-story timeout in seconds
    #[arg(long, default_value = "600")]
    timeout: u64,

    /// Override model for all phases (valid: opus, sonnet, haiku)
    #[arg(long = "model", value_parser = ["opus", "sonnet", "haiku"])]
    model: Option<String>,

    /// Effort level for spawned `claude` processes (the Architect,
    /// Planner, and Story agents on the `claude` backend). Higher =
    /// more thinking per turn at more tokens. `max` matches Claude
    /// Code's max-effort dynamic-workflows mode. Default: high.
    #[arg(long, value_parser = ["low", "medium", "high", "xhigh", "max"], default_value = "high")]
    effort: String,

    /// Disable model routing (equivalent to --model opus)
    #[arg(long = "no-model-routing")]
    no_model_routing: bool,

    /// Enable the live Critic: evaluates each agent turn against its
    /// acceptance criteria via `claude --model haiku` and injects
    /// corrective feedback when a turn doesn't satisfy them. Default: ON.
    #[arg(long)]
    no_critic: bool,

    /// (deprecated) Critic is on by default; use --no-critic to opt out.
    #[arg(long, hide = true)]
    with_critic: bool,

    /// Model used by the Critic. Default: "haiku".
    #[arg(long)]
    critic_model: Option<String>,

    /// Disable the Librarian (cross-agent runtime memory). Default: ON.
    #[arg(long)]
    no_librarian: bool,

    /// Disable the Sentry (file-touch conflict detector). Default: ON.
    #[arg(long)]
    no_sentry: bool,

    /// Disable the Surgeon: observes terminal story failures and proposes
    /// replans (split / prereq / rewire) so failed work gets done in a
    /// different shape rather than dropped. Default: ON.
    #[arg(long)]
    no_surgeon: bool,

    /// (deprecated) Surgeon is on by default; use --no-surgeon to opt out.
    #[arg(long, hide = true)]
    with_surgeon: bool,

    /// Use deterministic Surgeon (skip-only) instead of the LLM-driven
    /// replanner. The LLM Surgeon is on by default — it produces richer
    /// replans (split, prereq, rewire) at the cost of an Opus call per
    /// terminal failure.
    #[arg(long)]
    no_surgeon_llm: bool,

    /// (deprecated) LLM Surgeon is on by default; use --no-surgeon-llm to opt out.
    #[arg(long, hide = true)]
    surgeon_use_llm: bool,

    /// Model for the Surgeon LLM. Default: "opus".
    #[arg(long)]
    surgeon_model: Option<String>,

    /// Model used for the Architect phase. Overrides the routed default
    /// (opus) and any `--llm`-side default (gpt-5.5). Beaten only by
    /// the global `--model` flag, which forces every phase to one model.
    #[arg(long)]
    architect_model: Option<String>,

    /// Model used for the Planner phase. Same precedence rules as
    /// `--architect-model`. Default: routed (opus) for Claude, gpt-5.4
    /// for OpenAI.
    #[arg(long)]
    planner_model: Option<String>,

    /// Model used for every Story Agent in the run. Same precedence
    /// rules. Default: routed (opus) for Claude, gpt-5.5 for OpenAI.
    #[arg(long)]
    story_model: Option<String>,

    /// Seconds to wait between successive story spawns inside the same
    /// DAG level. Gives Librarian a window to capture and broadcast
    /// the first agent's exploratory tool calls so its peers don't
    /// repeat the same Reads/Greps. Default: 10. Set to 0 to disable.
    #[arg(long = "intra-level-delay")]
    intra_level_delay: Option<u64>,

    /// Run a self-diagnostic and exit. Verifies the `claude` CLI is on
    /// PATH, can return a version, can complete a trivial authenticated
    /// call, plus checks for `gh` and a writable audit directory.
    /// Use this when a baro run fails before any agents start.
    #[arg(long)]
    doctor: bool,

    /// Quick mode for trivial goals. Skips the Architect phase, forces
    /// the Planner to emit exactly one story, and disables Critic +
    /// Surgeon. Use this when you'd otherwise type your prompt directly
    /// into Claude Code: `baro --quick "fix the typo on line 42"`.
    /// One agent, tight scope, no design-document overhead.
    #[arg(long)]
    quick: bool,

    /// LLM provider for the run.
    ///
    ///   claude (default) — drives Architect, Planner, Critic, Surgeon,
    ///                      and StoryAgent through the Claude Code CLI.
    ///   openai           — drives all five through Mozaik's native
    ///                      OpenAI runner (gpt-5.x). Requires
    ///                      OPENAI_API_KEY in the environment OR entered
    ///                      on the provider-picker screen when running
    ///                      interactively.
    ///   codex            — subscription-arbitrage path via OpenAI Codex
    ///                      CLI (ChatGPT Plus/Pro billing). All five
    ///                      phases route through Codex.
    ///   hybrid           — preset that mixes vendors per phase:
    ///                      Architect / Planner / Surgeon stay on
    ///                      Claude (high-stakes, low-volume), Story and
    ///                      Critic move to Codex (high-volume, cheap
    ///                      on ChatGPT subscription). Individual phase
    ///                      overrides win when set.
    #[arg(long, default_value = "claude", value_parser = ["claude", "openai", "codex", "hybrid"])]
    llm: String,

    /// Per-phase overrides. Each accepts claude | openai | codex and
    /// wins over `--llm` (including the `hybrid` preset) for that one
    /// phase. Useful for surgical tuning: e.g. `--llm hybrid
    /// --critic-llm claude` for a hybrid run that uses Claude for
    /// Critic instead of Codex.
    #[arg(long, value_parser = ["claude", "openai", "codex"])]
    architect_llm: Option<String>,
    #[arg(long, value_parser = ["claude", "openai", "codex"])]
    planner_llm: Option<String>,
    #[arg(long, value_parser = ["claude", "openai", "codex"])]
    story_llm: Option<String>,
    #[arg(long, value_parser = ["claude", "openai", "codex"])]
    critic_llm: Option<String>,
    #[arg(long, value_parser = ["claude", "openai", "codex"])]
    surgeon_llm: Option<String>,
}

enum AppEvent {
    Baro(BaroEvent),
    Key(crossterm::event::KeyEvent),
    ContextReady(String),
    ContextError(String),
    PlanReady(Vec<ReviewStory>, String, String, String),
    /// Planner or Architect failed. Second tuple element is the path
    /// to the full stdout+stderr log on disk (if claude_runner managed
    /// to persist one). The planning screen surfaces both.
    PlanError(String, Option<std::path::PathBuf>),
    RefineReady(Vec<ReviewStory>, String, String, String),
    RefineError(String),
    BranchError(String),
    /// Fresh branch creation succeeded. Payload is the suffixed full
    /// branch name (e.g. `baro/add-anthropic-provider-12345`) that the
    /// async git task settled on. The handler mutates `app.branch_name`
    /// so the TUI and any later `_baro` snapshot reflect the actual
    /// branch the orchestrator is working on. Without this the display
    /// stays stuck on the pre-suffix name from the planner.
    BranchReady(String),
    ArchitectStarted,
    ArchitectComplete(String), // decision document (markdown)
    ArchitectSkipped(String),  // reason (not fatal — planner will still run)
    Tick,
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
    let cli = Cli::parse();

    // `baro --doctor` short-circuits before any TUI setup. It's a
    // diagnostic command, not a run, and it has to work even when the
    // things a real run depends on (e.g. claude CLI auth) are broken
    // — that's the whole point of it existing.
    if cli.doctor {
        std::process::exit(doctor::run().await);
    }

    // Resolve cwd early so we can acquire the session lock before entering the TUI
    let cwd = std::fs::canonicalize(&cli.cwd)?;

    // Acquire session lock — prints error and exits if another session is active
    let _lock = match SessionLock::acquire(&cwd) {
        Ok(lock) => lock,
        Err(msg) => {
            eprintln!("{}", msg);
            std::process::exit(1);
        }
    };

    let mut writer = open_terminal_writer()?;
    enable_raw_mode()?;
    execute!(writer, EnterAlternateScreen)?;
    execute!(writer, Clear(ClearType::All))?;
    execute!(writer, Clear(ClearType::Purge))?;
    let backend = CrosstermBackend::new(writer);
    let mut terminal = Terminal::new(backend)?;

    let result = run_app(&mut terminal, cli).await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    terminal.backend_mut().flush()?;

    // _lock is dropped here, removing baro.lock

    if let Err(err) = result {
        eprintln!("Error: {}", err);
        std::process::exit(1);
    }

    Ok(())
}

async fn run_app(
    terminal: &mut Terminal<CrosstermBackend<Box<dyn Write>>>,
    cli: Cli,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new();
    let cwd = std::fs::canonicalize(&cli.cwd)?;

    // Load .barorc config (defaults if not found)
    let rc = config::load_config(&cwd);

    // Apply config defaults, then CLI overrides
    app.parallel_limit = rc.parallel.unwrap_or(0);
    app.timeout_secs = rc.timeout.unwrap_or(600);

    app.planner = match rc.planner.as_deref() {
        Some("openai") => Planner::OpenAI,
        _ => Planner::Claude,
    };

    match rc.model.as_deref() {
        Some("opus") | Some("sonnet") | Some("haiku") => {
            app.override_model = rc.model.clone();
            app.model_routing = false;
        }
        _ => {} // "routed" or None = keep defaults
    }

    // CLI args override config
    if cli.parallel != 0 { app.parallel_limit = cli.parallel; }
    if cli.timeout != 600 { app.timeout_secs = cli.timeout; }

    if cli.planner != "claude" {
        app.planner = match cli.planner.as_str() {
            "openai" => Planner::OpenAI,
            _ => Planner::Claude,
        };
    }

    if let Some(ref model) = cli.model {
        app.override_model = Some(model.clone());
        app.model_routing = false;
    } else if cli.no_model_routing {
        app.override_model = Some("opus".to_string());
        app.model_routing = false;
    }

    // Critic + Surgeon (with LLM) are now ON by default. The historical
    // --with-critic / --with-surgeon / --surgeon-use-llm flags are still
    // accepted (hidden) for backwards compatibility; --no-* flags opt out.
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
    if let Some(d) = cli.intra_level_delay {
        app.intra_level_delay_secs = Some(d);
    }

    // --quick is the user telling us "this is trivial, don't ceremony it".
    // We honour that on three fronts: skip Architect (no design doc),
    // tell Planner to emit a 1-story DAG, and silence Critic + Surgeon
    // (their value is in coordinating parallel work that --quick doesn't
    // have). Librarian + Sentry stay on — they're cheap and harmless.
    if cli.quick {
        app.quick = true;
        app.with_critic = false;
        app.with_surgeon = false;
    }

    // Effort level for spawned `claude` processes (default "high").
    app.effort = cli.effort.clone();

    // --llm picks the LLM provider. Three legacy values (claude /
    // openai / codex) route every phase through one backend. The
    // `hybrid` preset splits per-phase: Claude for Architect /
    // Planner / Surgeon (high-stakes, low-volume calls), Codex for
    // Story + Critic (high-volume, cheap on subscription).
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
                    let stories: Vec<ReviewStory> = prd.user_stories.iter().map(|s| ReviewStory {
                        id: s.id.clone(),
                        title: s.title.clone(),
                        description: s.description.clone(),
                        depends_on: s.depends_on.clone(),
                        completed: s.passes,
                        model: s.model.clone(),
                    }).collect();
                    app.show_review(stories);
                    entered_resume = true;
                }
            }
        }
    }

    // Pre-fill OpenAI key from env BEFORE the goal branching below.
    // Was previously inside the no-goal else-branch — that meant
    // `baro --llm openai "<goal>"` skipped both the env-read AND the
    // API-key entry screen, so if the user didn't have OPENAI_API_KEY
    // in their shell the planner subprocess started with no key and
    // crashed on "OPENAI_API_KEY is not set".
    if let Ok(env_key) = std::env::var("OPENAI_API_KEY") {
        if !env_key.is_empty() {
            app.openai_api_key = Some(env_key);
        }
    }

    // If goal provided via CLI (and not resuming), skip welcome and start context/planning.
    // Otherwise: if there's no goal and we're not resuming, start at the
    // ProviderPicker so the user picks Claude vs OpenAI before typing
    // anything. They can still skip the picker by passing `--llm` (we
    // honour the explicit choice and jump straight to Welcome).
    if !entered_resume {
        if let Some(goal) = cli.goal {
            app.goal_input = goal;
            // CLI-goal + --llm openai + no API key anywhere → detour
            // through the ApiKeyInput screen first. The ApiKeyInput
            // Enter handler sees `goal_input` is already set and jumps
            // straight to planning after the key is captured, so the
            // user never goes through Welcome.
            if app.llm == app::LlmProvider::OpenAI && app.openai_api_key.is_none() {
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
                    spawn_planner(&app, &cwd, tx.clone());
                } else {
                    app.start_context();
                    spawn_context_builder(&cwd, tx.clone());
                }
            }
        } else {
            // No goal: show ProviderPicker first.
            app.screen = app::Screen::ProviderPicker;
        }
    }

    // Keyboard input from /dev/tty
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

    // Tick timer
    let tx_tick = tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if tx_tick.send(AppEvent::Tick).await.is_err() { break; }
        }
    });

    loop {
        terminal.draw(|f| ui::render(f, &mut app))?;
        match rx.recv().await {
            Some(AppEvent::Baro(ev)) => {
                // Fire notification immediately when stories complete
                if matches!(ev, BaroEvent::NotificationReady) {
                    notification::notify_completion();
                }
                let story_start_id = if let BaroEvent::StoryStart { ref id, .. } = ev {
                    Some(id.clone())
                } else {
                    None
                };
                app.handle_event(ev);
                if story_start_id.is_some() {
                    app.auto_scroll_to_running();
                }
                if let Some(ref sid) = story_start_id {
                    if app.global_tab == app::GlobalTab::Dag {
                        let visible = terminal.size().map(|s| s.height.saturating_sub(10)).unwrap_or(20);
                        app.dag_auto_scroll_to_story(sid, visible);
                    }
                }
            }
            Some(AppEvent::ContextReady(content)) => {
                app.claude_md_content = Some(content);
                app.start_planning();
                spawn_planner(&app, &cwd, tx.clone());
            }
            Some(AppEvent::ContextError(err)) => {
                app.planning_error = Some(err);
            }
            Some(AppEvent::PlanReady(stories, project, branch, description)) => {
                app.project = project;
                app.branch_name = branch;
                app.description = description;
                app.show_review(stories);
            }
            Some(AppEvent::PlanError(err, log_path)) => {
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
                app.architect_status = app::ArchitectStatus::Running;
            }
            Some(AppEvent::ArchitectComplete(doc)) => {
                app.architect_status = app::ArchitectStatus::Complete;
                app.decision_document = Some(doc);
            }
            Some(AppEvent::ArchitectSkipped(reason)) => {
                app.architect_status = app::ArchitectStatus::Skipped(reason);
                app.decision_document = None;
            }
            Some(AppEvent::BranchError(err)) => {
                app.planning_error = Some(err);
                app.screen = Screen::Review;
            }
            Some(AppEvent::BranchReady(name)) => {
                app.branch_name = name;
            }
            Some(AppEvent::Key(key)) => {
                use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};
                // Ghostty (and other terminals that enable the kitty
                // keyboard protocol) emit Enter as a Release-only event
                // or as a literal CR/LF Char. The general Press-only
                // filter would swallow those. Let Enter-like events
                // through any kind; everything else still requires
                // Press so we don't double-fire on Release.
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
                            app.provider_picker_index = 0;
                        }
                        KeyCode::Down | KeyCode::Char('j') => {
                            app.provider_picker_index = 1;
                        }
                        KeyCode::Enter | KeyCode::Char('\r') | KeyCode::Char('\n') => {
                            if app.provider_picker_index == 0 {
                                app.llm = app::LlmProvider::Claude;
                                app.screen = Screen::Welcome;
                            } else {
                                app.llm = app::LlmProvider::OpenAI;
                                // Skip the API-key screen if the user
                                // already has the secret in their env.
                                if app.openai_api_key.is_some() {
                                    app.screen = Screen::Welcome;
                                } else {
                                    app.api_key_input.clear();
                                    app.screen = Screen::ApiKeyInput;
                                }
                            }
                        }
                        _ => {}
                    },
                    Screen::ApiKeyInput => match key.code {
                        KeyCode::Esc => {
                            // Back to provider picker — let the user
                            // change their mind without quitting the
                            // whole TUI.
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
                                // If the user invoked baro with a CLI
                                // goal, they already finished the "what
                                // should I do" step on the command line
                                // — jump straight to planning instead of
                                // dragging them through Welcome.
                                if !app.goal_input.is_empty() {
                                    let claude_md_path = cwd.join("CLAUDE.md");
                                    if claude_md_path.exists() {
                                        if let Ok(content) = std::fs::read_to_string(&claude_md_path) {
                                            ensure_agents_md_mirror(&cwd, &content);
                                            app.claude_md_content = Some(content);
                                        }
                                        app.start_planning();
                                        spawn_planner(&app, &cwd, tx.clone());
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
                                    spawn_planner(&app, &cwd, tx.clone());
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
                                app.goal_input.push(c);
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
                                spawn_planner(&app, &cwd, tx.clone());
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
                                        // 0.45.3+ persists the full "baro/<slug>-<suffix>"
                                        // name in prd.json; pre-0.45.3 stored the bare slug.
                                        // Accept either: use as-is when already prefixed,
                                        // otherwise prepend so legacy prd.json still resolves.
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
                                        let eff = app.effort.clone();
                                        let stm = app.story_model.clone();
                                        let err_tx = tx.clone();
                                        tokio::spawn(async move {
                                            // Resume path: prd.json already holds the
                                            // suffixed branch name from the prior fresh
                                            // run, so just check it out — never create a
                                            // new branch here (that would silently drift
                                            // off the user's prior work).
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
                                            spawn_executor(prd, exec_cwd, branch_tx, executor::ExecutorConfig { parallel: pl, timeout_secs: ts, model_routing: mr, override_model: om, with_critic: wc, critic_model: cm, with_librarian: wl, with_sentry: ws, with_surgeon: wsg, surgeon_use_llm: sul, surgeon_model: sm, intra_level_delay_secs: ild, llm, story_llm: sllm, critic_llm: cllm, surgeon_llm: surllm, openai_api_key: oak.clone(), effort: eff.clone(), story_model: stm.clone() });
                                        });
                                    }
                                    Err(e) => {
                                        app.planning_error = Some(format!("Failed to read prd.json: {}", e));
                                    }
                                }
                            } else {
                                // Normal mode: write prd.json and start execution
                                let prd = executor::prd_from_review(
                                    &app.project,
                                    &app.branch_name,
                                    &app.description,
                                    &app.review_stories,
                                    app.decision_document.clone(),
                                );
                                if let Err(e) = executor::write_prd(&prd, &cwd) {
                                    app.planning_error = Some(format!("Failed to write prd.json: {}", e));
                                } else {
                                    // Create git branch baro/<branchName>
                                    let full_branch = format!("baro/{}", app.branch_name);
                                    let branch_cwd = cwd.clone();
                                    let branch_name_clone = full_branch.clone();
                                    app.branch_name = full_branch;
                                    app.start_execution();
                                    let exec_prd = prd;
                                    let exec_cwd = cwd.clone();
                                    let branch_tx = tx.clone();
                                    let mr = app.model_routing;
                                    let om = app.override_model.clone();
                                    let pl = app.parallel_limit;
                                    let ts = app.timeout_secs;
                                    let wc = app.with_critic;
                                    let cm = app.critic_model.clone();
                                    let wl = app.with_librarian;
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
                                    let eff = app.effort.clone();
                                    let stm = app.story_model.clone();
                                    let err_tx = tx.clone();
                                    tokio::spawn(async move {
                                        // Fresh run: ALWAYS create a new suffixed branch
                                        // (no fallback to checkout). Side-by-side runs
                                        // from sibling clones with the same origin would
                                        // otherwise collide on `git push`, and the user
                                        // explicitly wants every run on its own branch.
                                        let actual_full_branch = match git::create_fresh_branch(&branch_cwd, &branch_name_clone).await {
                                            Ok(name) => name,
                                            Err(e) => {
                                                let _ = err_tx.send(AppEvent::BranchError(
                                                    format!("Branch creation failed: {}. Cannot proceed on main branch.", e)
                                                )).await;
                                                return;
                                            }
                                        };
                                        // Persist the FULL "baro/<slug>-<suffix>" name back
                                        // to prd.json — exactly the branch Rust just created
                                        // and checked out. The Mozaik orchestrator reads
                                        // prd.branchName verbatim for its own
                                        // createOrCheckoutBranch + Finalizer; stripping the
                                        // "baro/" prefix here made it create a SECOND,
                                        // un-prefixed branch ("<slug>-<suffix>") and commit
                                        // every story there, leaving the prefixed branch empty
                                        // and breaking resume (which looks for the prefixed
                                        // one). Storing the prefixed name keeps Rust, Mozaik,
                                        // and resume on a single branch.
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
                                        spawn_executor(exec_prd, exec_cwd, branch_tx, executor::ExecutorConfig { parallel: pl, timeout_secs: ts, model_routing: mr, override_model: om, with_critic: wc, critic_model: cm, with_librarian: wl, with_sentry: ws, with_surgeon: wsg, surgeon_use_llm: sul, surgeon_model: sm, intra_level_delay_secs: ild, llm, story_llm: sllm, critic_llm: cllm, surgeon_llm: surllm, openai_api_key: oak.clone(), effort: eff.clone(), story_model: stm.clone() });
                                    });
                                }
                            }
                        }
                        KeyCode::Up | KeyCode::Char('k') => app.review_prev(),
                        KeyCode::Down | KeyCode::Char('j') => app.review_next(),
                        _ => {}
                    }},
                    Screen::Execute => match key.code {
                        KeyCode::Char('q') => return Ok(()),
                        // Force a full terminal clear on every tab change.
                        // ratatui's `Clear` widget only marks cells stale in
                        // its own buffer and isn't reliably writing spaces to
                        // every cell of the rect, so old tab content bleeds
                        // through (the "es';"/"mon';" debris on the right
                        // side, vertical bars in the stories panel, etc.).
                        // terminal.clear() blanks the actual terminal cells;
                        // the next render redraws from a clean slate.
                        KeyCode::Char('1') => {
                            app.global_tab = app::GlobalTab::Dashboard;
                            let _ = terminal.clear();
                        }
                        KeyCode::Char('2') => {
                            app.global_tab = app::GlobalTab::Dag;
                            let _ = terminal.clear();
                        }
                        KeyCode::Char('3') => {
                            app.global_tab = app::GlobalTab::Stats;
                            let _ = terminal.clear();
                        }
                        KeyCode::Tab => {
                            if key.modifiers.contains(KeyModifiers::SHIFT) { app.prev_log(); }
                            else { app.next_log(); }
                        }
                        KeyCode::BackTab => app.prev_log(),
                        KeyCode::Left => app.prev_tab(),
                        KeyCode::Right => app.next_tab(),
                        KeyCode::Up | KeyCode::Char('k') => {
                            if app.global_tab == app::GlobalTab::Dashboard {
                                let inner_h = terminal.size().map(|s| s.height.saturating_sub(12) as usize).unwrap_or(20);
                                let active_ids = app.active_story_ids();
                                let selected_id = active_ids.get(app.selected_log_index).cloned().unwrap_or_default();
                                if !app.review_logs.is_empty() && active_ids.is_empty() {
                                    let total = app.review_logs.len();
                                    app.review_log_scroll_up(1, total, inner_h);
                                } else if let Some(story) = app.active_stories.get(&selected_id) {
                                    let total = story.logs.len();
                                    app.log_scroll_up(1, total, inner_h);
                                }
                            } else if app.global_tab == app::GlobalTab::Dag {
                                app.dag_scroll_up();
                            }
                        }
                        KeyCode::Down | KeyCode::Char('j') => {
                            if app.global_tab == app::GlobalTab::Dashboard {
                                let inner_h = terminal.size().map(|s| s.height.saturating_sub(12) as usize).unwrap_or(20);
                                let active_ids = app.active_story_ids();
                                let selected_id = active_ids.get(app.selected_log_index).cloned().unwrap_or_default();
                                if !app.review_logs.is_empty() && active_ids.is_empty() {
                                    let total = app.review_logs.len();
                                    app.review_log_scroll_down(1, total, inner_h);
                                } else if let Some(story) = app.active_stories.get(&selected_id) {
                                    let total = story.logs.len();
                                    app.log_scroll_down(1, total, inner_h);
                                }
                            } else if app.global_tab == app::GlobalTab::Dag {
                                let total = app.dag_line_count();
                                let visible = terminal.size().map(|s| s.height.saturating_sub(10)).unwrap_or(20);
                                app.dag_scroll_down(total, visible);
                            }
                        }
                        _ => {}
                    },
                }
            }
            Some(AppEvent::Tick) => {
                app.tick_count += 1;
            }
            None => break,
        }
    }
    Ok(())
}

fn spawn_planner(app: &App, cwd: &Path, tx: mpsc::Sender<AppEvent>) {
    let goal = app.goal_input.clone();
    let planner = app.planner;
    let cwd = cwd.to_path_buf();
    let model = app.model_for_phase("planning");
    let architect_model = app.model_for_phase("architect");
    let context = app.claude_md_content.clone();
    let quick = app.quick;
    // Per-phase routing: architect_llm and planner_llm let hybrid
    // runs route Architect / Planner through Claude even when
    // Story/Critic/Surgeon move to Codex (and vice versa). When the
    // user didn't set per-phase overrides, both fall back to the
    // global --llm value (set during CLI parsing).
    let architect_llm = app.architect_llm;
    let planner_llm = app.planner_llm;
    let openai_api_key = app.openai_api_key.clone();
    let effort = app.effort.clone();

    tokio::spawn(async move {
        // Phase 1 — Architect. In quick mode we skip this entirely:
        // the Architect's job is to align multiple parallel agents on
        // cross-cutting decisions, and quick runs are single-agent. We
        // still emit ArchitectSkipped so the TUI shows the user *why*
        // there's no design document for this run.
        let decision_doc = if quick {
            let _ = tx
                .send(AppEvent::ArchitectSkipped(
                    "Quick mode — no design document needed for a single-story run.".to_string(),
                ))
                .await;
            None
        } else if matches!(planner, Planner::Claude) {
            let _ = tx.send(AppEvent::ArchitectStarted).await;
            match architect_runner::run_architect(
                &goal,
                &cwd,
                architect_llm,
                architect_model.as_deref(),
                context.as_deref(),
                openai_api_key.as_deref(),
                &effort,
            ).await {
                Ok(doc) => {
                    let _ = tx.send(AppEvent::ArchitectComplete(doc.clone())).await;
                    Some(doc)
                }
                Err(e) => {
                    // Non-fatal: planner runs without authoritative spec,
                    // matching pre-0.25 behaviour. The TUI surfaces this
                    // so the user knows why this run might drift.
                    let _ = tx
                        .send(AppEvent::ArchitectSkipped(format!(
                            "Architect phase failed: {}. Falling back to planner-only flow.",
                            e
                        )))
                        .await;
                    None
                }
            }
        } else {
            None
        };

        // Phase 2 — Planner. TS subprocess decides Claude vs OpenAI
        // based on --llm, prints the PRD JSON to stdout. The legacy
        // `app.planner` enum is now redundant with `app.llm`; we
        // route entirely off the latter.
        let _ = planner; // legacy field kept on App for the welcome-screen wizard
        let result = planner_runner::run_planner(
            &goal,
            &cwd,
            planner_llm,
            model.as_deref(),
            context.as_deref(),
            decision_doc.as_deref(),
            quick,
            openai_api_key.as_deref(),
            &effort,
        ).await;

        match result.and_then(|raw_json| {
            // Parse the PRD JSON the TS planner emitted. Same schema
            // as the old Rust path consumed — Rust stays the single
            // source of truth for `PrdOutput`.
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
            Ok((stories, prd.project, prd.branch_name, prd.description))
        }) {
            Ok((stories, project, branch, description)) => {
                let _ = tx
                    .send(AppEvent::PlanReady(stories, project, branch, description))
                    .await;
            }
            Err(err) => {
                let _ = tx
                    .send(AppEvent::PlanError(err.message.clone(), err.log_path))
                    .await;
            }
        }
    });
}

/// Mirror CLAUDE.md content into AGENTS.md so subprocess backends
/// that follow the AGENTS.md convention (OpenAI Codex CLI) pick up
/// the same project context Claude Code reads from CLAUDE.md.
///
/// Idempotent: only writes if AGENTS.md doesn't already exist (so a
/// hand-curated AGENTS.md from the user is never overwritten). Soft-
/// fail: any write error is silently ignored — CLAUDE.md path stays
/// authoritative.
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
                // Mirror the same content to AGENTS.md so subprocess
                // backends that use the AGENTS.md convention (OpenAI
                // Codex CLI, future agents) auto-pick up the project
                // context the same way Claude Code picks up CLAUDE.md.
                // Both files carry identical bytes — neither backend
                // gets unique context the other doesn't have. Soft-
                // fail: if AGENTS.md write errors, log + continue,
                // since CLAUDE.md is still written and Claude path
                // still works.
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

fn spawn_executor(
    _prd: executor::PrdFile,
    cwd: PathBuf,
    tx: mpsc::Sender<AppEvent>,
    config: executor::ExecutorConfig,
) {
    // The orchestrator (TS, Mozaik-based) replaces the in-process Rust
    // executor. Bridge BaroEvent → AppEvent::Baro the same way the old
    // executor did so app/screens stay untouched.
    let (exec_tx, mut exec_rx) = mpsc::channel::<BaroEvent>(256);

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

    // Default audit log path: ~/.baro/runs/<project>-<unix-secs>.jsonl.
    // Living under the user's home directory (not the project's <cwd>/.baro/)
    // means the diagnostic trail survives anything that touches the
    // project working tree: git checkouts, branch switches, manual
    // cleanups, IDE indexers — none of those reach into ~. We had a
    // run where 495 KB of audit data vanished from <cwd>/.baro/runs/
    // between the run ending and the user kill; we still don't know
    // what wiped it, but moving the file out of the project dir means
    // we don't have to find out.
    //
    // Always-on so post-mortems on stuck/abnormal runs are possible
    // without rerunning. We pre-touch BOTH the audit JSONL and the
    // stderr.txt sidecar before spawning the orchestrator so the
    // diagnostic surface exists even if the JS process explodes inside
    // its first 50ms.
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
    // Pre-touch the JSONL so external watchers (and our own diagnostics)
    // can rely on the file existing even before the Auditor opens it.
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
    // Pre-touch the stderr sidecar for the same reason.
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
        effort: config.effort,
        story_model: config.story_model,
    };
    orchestrator_client::spawn_orchestrator(orch_cfg, exec_tx);
}


