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
use tokio::process::Command;
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

    /// Which LLM provider runs the agents. `claude` (default) uses the
    /// Claude Code CLI as today. `openai` routes every phase through
    /// Mozaik's native OpenAI participants. Hidden until OpenAI mode is
    /// feature-complete end-to-end — currently a no-op placeholder.
    #[arg(long, default_value = "claude", value_parser = ["claude", "openai"], hide = true)]
    llm: String,
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


const CLAUDE_PLANNER_PROMPT: &str = r#"You are an expert software architect. Break down the user's project goal into concrete user stories that form a dependency DAG.

You MUST explore the existing codebase first using your tools (read files, list directories, etc.) before generating the plan.

TRIAGE FIRST — DO NOT SKIP THIS STEP:
Before you decompose, decide whether the goal is TRIVIAL or NON-TRIVIAL.

A goal is TRIVIAL when ALL of these hold:
  - It names a single concept (one bug, one rename, one typo, one small addition).
  - It can plausibly be done by touching a small number of files in one focused
    edit, with no cross-cutting decisions and no new dependencies.
  - Splitting it would just create artificial seams (e.g. "Story 1: locate the typo,
    Story 2: fix the typo" is wrong — that's one story).
  - It does NOT introduce a new feature surface, schema, or API contract.

Examples of TRIVIAL goals:
  - "Fix the typo in the README footer"
  - "Rename `getUser` to `fetchUser` across the auth module"
  - "Bump axios to 1.7.x"
  - "Add a `created_at` index on the orders table"
  - "Fix the off-by-one in pagination.ts"

If the goal is TRIVIAL: output EXACTLY ONE story. Set its description to the user's
goal restated in implementation terms. Set acceptance to a single, tight criterion
(e.g. "the typo is fixed in README.md"). Use the minimum useful test command
(typically just `npm run build` or `cargo check`, not a full test suite). Do NOT
decompose further. Do NOT invent a "verify" story — verification is part of the
single story's acceptance.

If the goal is NON-TRIVIAL: decompose normally per the rules below.

When in doubt, prefer FEWER stories over more. A single 2-file story is better
than two artificially-split 1-file stories.

Output ONLY valid JSON matching this exact schema (no markdown, no explanation, just JSON):
{
  "project": "short project name",
  "branchName": "kebab-case-branch-name",
  "description": "one-line description",
  "userStories": [
    {
      "id": "S1",
      "priority": 1,
      "title": "short title",
      "description": "what to implement",
      "dependsOn": [],
      "retries": 2,
      "acceptance": ["testable criterion"],
      "tests": ["npm test"],
      "model": "opus"
    }
  ]
}

Rules:
- Each story: ONE focused unit of work for one AI agent. Hard cap:
    * touches at most ~10 files
    * fits in a single Claude turn (a few minutes of execution, not an hour)
  Stories that read like "Strip all X" / "Refactor everything that touches Y"
  are TOO BIG. Split them by directory, by feature, or by file group:
    "Delete backend SEF module"
    "Delete frontend SEF wiring"
    "Rename pib→taxId in schema + DTOs"
    "Rename pib→taxId in services + frontend forms"
  Prefer 12-15 small stories over 5 big ones.
- Default execution model is "opus". Only set "model" if you want to
  override (e.g. set to "sonnet" or "haiku" for trivial cosmetic stories
  that don't need deep reasoning). For everything substantive, leave
  the field out and let the default opus run it.
- Use dependsOn for dependencies; same-priority stories with no deps run IN PARALLEL
- Include testable acceptance criteria and test commands
- No circular dependencies
- Start with foundational stories, build up
- IDs: S1, S2, S3...
- Build on existing code, don't recreate what exists
- Output ONLY the JSON, nothing else"#;

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

    // --llm picks the LLM provider for every phase. Default is the
    // Claude CLI flow (existing). "openai" is wired through to the
    // orchestrator but doesn't yet route any phase to native OpenAI
    // participants — that comes online phase-by-phase in 0.29+. Until
    // then, --llm openai is a no-op placeholder hidden from --help.
    if let Some(provider) = app::LlmProvider::parse(&cli.llm) {
        app.llm = provider;
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

    // If goal provided via CLI (and not resuming), skip welcome and start context/planning
    if !entered_resume {
        if let Some(goal) = cli.goal {
            app.goal_input = goal;
            let claude_md_path = cwd.join("CLAUDE.md");
            if claude_md_path.exists() {
                if let Ok(content) = std::fs::read_to_string(&claude_md_path) {
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
            Some(AppEvent::Key(key)) => {
                use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                // Clear dock badge when user returns to the terminal after a notification
                if app.notification_ready {
                    notification::clear_badge();
                }

                match app.screen {
                    Screen::Welcome => match key.code {
                        KeyCode::Esc => return Ok(()),
                        KeyCode::Tab => { app.welcome_field = app.welcome_field.next(); }
                        KeyCode::BackTab => { app.welcome_field = app.welcome_field.prev(); }
                        KeyCode::Enter => {
                            if app.welcome_field != app::WelcomeField::Goal {
                                // Enter on non-goal fields = jump to goal
                                app.welcome_field = app::WelcomeField::Goal;
                            } else if !app.goal_input.is_empty() {
                                let claude_md_path = cwd.join("CLAUDE.md");
                                if claude_md_path.exists() {
                                    if let Ok(content) = std::fs::read_to_string(&claude_md_path) {
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
                            KeyCode::Enter => {
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
                        KeyCode::Enter => {
                            if app.is_resume {
                                // Resume mode: read existing prd.json (has full acceptance/tests data)
                                let prd_path = cwd.join("prd.json");
                                match std::fs::read_to_string(&prd_path)
                                    .map_err(|e| e.to_string())
                                    .and_then(|c| serde_json::from_str::<executor::PrdFile>(&c).map_err(|e| e.to_string()))
                                {
                                    Ok(prd) => {
                                        let full_branch = format!("baro/{}", prd.branch_name);
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
                                        let err_tx = tx.clone();
                                        tokio::spawn(async move {
                                            if let Err(e) = git::create_or_checkout_branch(&branch_cwd, &branch_name_clone).await {
                                                let _ = err_tx.send(AppEvent::BranchError(
                                                    format!("Branch creation failed: {}. Cannot proceed on main branch.", e)
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
                                            spawn_executor(prd, exec_cwd, branch_tx, executor::ExecutorConfig { parallel: pl, timeout_secs: ts, model_routing: mr, override_model: om, with_critic: wc, critic_model: cm, with_librarian: wl, with_sentry: ws, with_surgeon: wsg, surgeon_use_llm: sul, surgeon_model: sm, intra_level_delay_secs: ild, llm });
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
                                    let err_tx = tx.clone();
                                    tokio::spawn(async move {
                                        if let Err(e) = git::create_or_checkout_branch(&branch_cwd, &branch_name_clone).await {
                                            let _ = err_tx.send(AppEvent::BranchError(
                                                format!("Branch creation failed: {}. Cannot proceed on main branch.", e)
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
                                        spawn_executor(exec_prd, exec_cwd, branch_tx, executor::ExecutorConfig { parallel: pl, timeout_secs: ts, model_routing: mr, override_model: om, with_critic: wc, critic_model: cm, with_librarian: wl, with_sentry: ws, with_surgeon: wsg, surgeon_use_llm: sul, surgeon_model: sm, intra_level_delay_secs: ild, llm });
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
    let llm = app.llm;

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
            match architect_runner::run_architect(&goal, &cwd, llm, architect_model.as_deref(), context.as_deref()).await {
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

        // Phase 2 — Planner (now informed by the DecisionDocument when present).
        // In quick mode, the planner is told to emit exactly one story.
        let result = match planner {
            Planner::Claude => {
                run_claude_planner(&goal, &cwd, model.as_deref(), context.as_deref(), decision_doc.as_deref(), quick).await
            }
            Planner::OpenAI => run_openai_planner(&goal, &cwd).await,
        };

        match result {
            Ok((stories, project, branch, description)) => {
                let _ = tx
                    .send(AppEvent::PlanReady(stories, project, branch, description))
                    .await;
            }
            Err(e) => {
                // If the error came from claude_runner, it carries the
                // path to the persisted stdout+stderr log — surface it
                // so the user can see the full diagnostic, not just the
                // truncated headline.
                let log_path = e
                    .downcast_ref::<subprocess::ProcessRunError>()
                    .and_then(|err| err.log_path.clone());
                let _ = tx.send(AppEvent::PlanError(e.to_string(), log_path)).await;
            }
        }
    });
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
    };
    orchestrator_client::spawn_orchestrator(orch_cfg, exec_tx);
}

async fn run_claude_planner(
    goal: &str,
    cwd: &Path,
    model: Option<&str>,
    context: Option<&str>,
    decision_doc: Option<&str>,
    quick: bool,
) -> Result<(Vec<ReviewStory>, String, String, String), Box<dyn std::error::Error + Send + Sync>> {
    let base_prompt = format!("{}\n\nUser goal: {}", CLAUDE_PLANNER_PROMPT, goal);
    let with_design = match decision_doc {
        Some(doc) => format!(
            "AUTHORITATIVE DESIGN SPEC (already decided by the Architect — every story you produce must implement THESE specific file paths, names, and shapes; do NOT invent alternatives):\n\n{}\n\n{}",
            doc, base_prompt,
        ),
        None => base_prompt,
    };
    // --quick: hard override. The triage in the planner prompt may still
    // misjudge a goal as non-trivial; --quick is the user's vote and it wins.
    let with_quick = if quick {
        format!(
            "{}\n\nQUICK MODE OVERRIDE — the user invoked `baro --quick`. They have told us this goal is trivial. You MUST output EXACTLY ONE story. Do not split. Do not decompose. Do not add a `verify` story. If you genuinely cannot do this in one story, emit the one story anyway with a description that explains what's missing; the user will rerun without --quick. One story, tight acceptance, minimum useful test command.",
            with_design
        )
    } else {
        with_design
    };
    let prompt = match context {
        Some(ctx) => format!("Here is the project context:\n{}\n\n{}", ctx, with_quick),
        None => with_quick,
    };

    let config = claude_runner::ClaudeRunConfig {
        prompt,
        cwd: cwd.to_path_buf(),
        model: model.map(|s| s.to_string()),
        log_tag: Some("planner"),
    };

    let output = claude_runner::spawn_claude_json(&config).await?;

    // Claude --output-format json wraps the result; extract the text content
    let claude_output: serde_json::Value = serde_json::from_str(&output.stdout)
        .map_err(|e| format!("Failed to parse Claude JSON wrapper: {}", e))?;

    // The actual plan JSON is in the "result" field as a text string
    let plan_text = claude_output
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or(&output.stdout);

    let json_str = extract_json(plan_text);

    let prd: PrdOutput = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse PRD JSON: {}\nRaw: {}", e, &json_str[..json_str.len().min(500)]))?;

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
}

async fn run_openai_planner(goal: &str, cwd: &Path) -> Result<(Vec<ReviewStory>, String, String, String), Box<dyn std::error::Error + Send + Sync>> {
    // Find the openai-planner.js relative to the binary or use node_modules
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    // Try multiple locations for the planner script
    let script_paths = [
        exe_dir.as_ref().map(|d| d.join("openai-planner.js")),
        Some(cwd.join("node_modules/baro-ai/dist/openai-planner.js")),
        Some(cwd.join("openai-planner.js")),
    ];

    let script_path = script_paths
        .iter()
        .filter_map(|p| p.as_ref())
        .find(|p| p.exists())
        .ok_or("Could not find openai-planner.js")?
        .clone();

    let output = Command::new("node")
        .args([
            script_path.to_string_lossy().as_ref(),
            goal,
            "--cwd",
            &cwd.to_string_lossy(),
        ])
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?
        .wait_with_output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("OpenAI planner failed: {}", stderr).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let prd: PrdOutput = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse OpenAI PRD: {}", e))?;

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
}

