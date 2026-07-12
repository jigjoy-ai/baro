use std::{fs};

use clap::{CommandFactory, Error, Parser, error::ErrorKind};

use crate::cli::session::SessionLock;

#[derive(Parser)]
#[command(
    name = "baro",
    version,
    about = "AI-powered project execution",
    after_help = "Issues: https://github.com/jigjoy-ai/baro/issues\nTwitter: @lotus_sbc"
)]
pub struct Cli {
    /// Project goal (if omitted, shows welcome screen)
    pub goal: Option<String>,

    /// Planner to use
    #[arg(long, default_value="claude", value_parser = ["claude", "openai"])]
    pub planner: String,

    /// Working directory
    #[arg(long, default_value = ".")]
    pub cwd: String,

    /// Resume execution from existing prd.json
    #[arg(long)]
    pub resume: bool,

    /// Max parallel story executors (0 = unlimited)
    #[arg(long, default_value = "0")]
    pub parallel: u32,

    /// Coordination engine: legacy (current Conductor) or collective (experimental event-bus agents).
    #[arg(long, value_parser=["legacy", "collective"], env = "BARO_COORDINATION", default_value = "legacy")]
    pub coordination: String,

    /// Disable Baro-owned pushes and pull requests; use a remote-free clone for hard isolation.
    #[arg(long)]
    pub local_only: bool,

    /// JSON file containing opt-in collective worker candidates and their bids.
    #[arg(long, env = "BARO_COLLECTIVE_WORKERS_FILE")]
    pub collective_workers: Option<String>,

    /// Milliseconds to collect collective worker bids before deterministic selection.
    #[arg(long, env = "BARO_COLLECTIVE_BID_WINDOW_MS")]
    pub collective_bid_window_ms: Option<u64>,

    /// Reject collective bids below this estimated success probability.
    #[arg(long, value_parser = parse_probability, env = "BARO_COLLECTIVE_MIN_SUCCESS")]
    pub collective_min_success: Option<f64>,

    /// Reject collective bids above this expected one-attempt cost in USD.
    #[arg(long, value_parser = parse_non_negative_f64, env = "BARO_COLLECTIVE_MAX_COST_USD")]
    pub collective_max_cost_usd: Option<f64>,

    /// Reject collective bids above this estimated latency in milliseconds.
    #[arg(long, env = "BARO_COLLECTIVE_MAX_LATENCY_MS")]
    pub collective_max_latency_ms: Option<u64>,

    /// Enable the optional communication-only conversation participant (collective mode only).
    #[arg(long)]
    pub with_dialogue: bool,

    /// Text-only backend for the conversation participant.
    #[arg(long, value_parser=["claude", "openai"], env = "BARO_DIALOGUE_LLM")]
    pub dialogue_llm: Option<String>,

    /// Model id for the optional conversation participant.
    #[arg(long, env = "BARO_DIALOGUE_MODEL")]
    pub dialogue_model: Option<String>,

    /// Per-story timeout in seconds. Default scales with --effort
    /// (max ≈ 25 min, xhigh ≈ 20, high ≈ 15, else 10).
    #[arg(long)]
    pub timeout: Option<u64>,

    /// Override model for all phases: opus/sonnet/haiku for claude;
    /// passed through verbatim for other backends (e.g. `openai/gpt-4o`).
    #[arg(long = "model", short = 'm')]
    pub model: Option<String>,

    /// Effort level for spawned `claude` processes; higher = more
    /// thinking per turn (`max` matches Claude Code's max-effort mode).
    #[arg(long, value_parser=["low", "medium", "high", "xhigh", "max"], default_value="high")]
    pub effort: String,

    /// Disable model routing (equivalent to --model opus)
    #[arg(long = "no-model-routing")]
    pub no_model_routing: bool,

    /// Disable the live Critic (evaluates each turn against its acceptance
    /// criteria and injects corrective feedback). Default: ON.
    #[arg(long)]
    pub no_critic: bool,

    /// (deprecated) Critic is on by default; use --no-critic to opt out.
    #[arg(long, hide = true)]
    with_critic: bool,

     /// Disable the Librarian (cross-agent runtime memory). Default: ON.
    #[arg(long)]
    pub no_librarian: bool,

    /// Disable the Sentry (file-touch conflict detector). Default: ON.
    #[arg(long)]
    pub no_sentry: bool,

    /// Disable the Surgeon (replans terminal story failures:
    /// split / prereq / rewire). Default: ON.
    #[arg(long)]
    pub no_surgeon: bool,

    /// (deprecated) Surgeon is on by default; use --no-surgeon to opt out.
    #[arg(long, hide = true)]
    with_surgeon: bool,

    /// Use the deterministic skip-only Surgeon instead of the LLM replanner
    /// (default: LLM, one Opus call per terminal failure).
    #[arg(long)]
    pub no_surgeon_llm: bool,

    /// (deprecated) LLM Surgeon is on by default; use --no-surgeon-llm to opt out.
    #[arg(long, hide = true)]
    surgeon_use_llm: bool,

    /// Model for the Surgeon LLM. Default: "opus".
    #[arg(long)]
    pub surgeon_model: Option<String>,

    /// Model for the Architect phase. Overrides the routed/backend
    /// default; only the global `--model` beats it.
    #[arg(long)]
    pub architect_model: Option<String>,

    /// Model for the Planner phase (same precedence as --architect-model).
    #[arg(long)]
    pub planner_model: Option<String>,

    /// Model used by the Critic. Default: "haiku".
    #[arg(long)]
    pub critic_model: Option<String>,

    /// Model for every Story Agent (same precedence as --architect-model).
    #[arg(long)]
    pub story_model: Option<String>,

    /// Per-story tier→backend:model map (tiers: light/standard/heavy;
    /// legacy haiku/sonnet/opus accepted), so one run can mix backends
    /// story-by-story. Example:
    ///   --tier-map "light=openai:MiniMax-M3,standard=openai:MiniMax-M3,heavy=claude:opus"
    #[arg(long = "tier-map")]
    pub tier_map: Option<String>,

    /// Register a named OpenAI-compatible endpoint, `name=url` (repeatable);
    /// reference it from a route as `openai:<model>@<name>`. The key is read
    /// from `BARO_OPENAI_KEY_<NAME>` (else `OPENAI_API_KEY`), never the CLI.
    #[arg(long = "openai-endpoint")]
    pub openai_endpoint: Vec<String>,

    /// Seconds between story spawns within a DAG level, giving the Librarian
    /// time to broadcast the first agent's discoveries. Default: 10; 0 disables.
    #[arg(long = "intra-level-delay")]
    pub intra_level_delay: Option<u64>,

    /// Run a self-diagnostic (claude CLI on PATH, auth, gh, writable
    /// audit dir) and exit.
    #[arg(long)]
    pub doctor: bool,

    /// Quick mode for trivial goals: skips the Architect, plans exactly
    /// one story, disables Critic + Surgeon.
    #[arg(long)]
    pub quick: bool,

    /// Continue a previous run on the CURRENT branch (follow-up lands on
    /// the existing PR); prior work on the branch is re-read as context.
    #[arg(long = "continue")]
    pub continue_run: bool,

    /// LLM provider for the run:
    ///   claude (default) — all phases via the Claude Code CLI.
    ///   openai           — all phases via the native OpenAI runner
    ///                      (needs OPENAI_API_KEY or the picker screen).
    ///   codex            — all phases via the OpenAI Codex CLI
    ///                      (ChatGPT Plus/Pro billing).
    ///   hybrid           — Architect/Planner/Surgeon on Claude,
    ///                      Story/Critic on Codex; phase overrides win.
    ///   jigjoy           — hosted baro gateway holding the upstream keys
    ///                      (JIGJOY_API_KEY; URL via BARO_JIGJOY_URL).
    #[arg(long, default_value="claude", value_parser=["claude", "openai", "codex", "opencode", "pi", "hybrid", "jigjoy"])]
    pub llm: String,

    /// Base URL for all OpenAI-routed calls instead of api.openai.com,
    /// for OpenAI-compatible providers (OpenRouter, vLLM, Ollama, ...).
    #[arg(long, env = "OPENAI_BASE_URL")]
    pub openai_base_url: Option<String>,

    /// Per-phase backend overrides; each wins over `--llm` (including
    /// the `hybrid` preset) for that one phase.
    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub architect_llm: Option<String>,
    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub planner_llm: Option<String>,
    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub story_llm: Option<String>,
    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub critic_llm: Option<String>,
    #[arg(long, value_parser=["claude", "openai", "codex", "opencode", "pi"])]
    pub surgeon_llm: Option<String>,

    /// Disable semantic memory (ONNX-embedding MemoryLibrarian); falls
    /// back to the tag-based Librarian. Default: ON.
    #[arg(long)]
    pub no_memory: bool,

    /// Run without the TUI: auto-confirm the plan and stream orchestrator
    /// event JSON to stdout (CI / automation). Requires a goal argument.
    #[arg(long)]
    pub headless: bool,

    /// Execution mode: auto (intake proposes, you confirm) or force focused/sequential/parallel.
    #[arg(long, value_parser=["auto", "focused", "sequential", "parallel"], env = "BARO_MODE", default_value = "auto")]
    pub mode: String,

    /// Ask-after-planning: in headless mode, emit the proposed execution mode
    /// and wait (≤120s) for a confirm_mode command before planning continues.
    #[arg(long, env = "BARO_CONFIRM_MODE")]
    pub confirm_mode: bool,
}

fn parse_probability(raw: &str) -> Result<f64, String> {
    let value = raw
        .parse::<f64>()
        .map_err(|_| "must be a number between 0 and 1".to_string())?;
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(value)
    } else {
        Err("must be a finite number between 0 and 1".to_string())
    }
}

fn parse_non_negative_f64(raw: &str) -> Result<f64, String> {
    let value = raw
        .parse::<f64>()
        .map_err(|_| "must be a non-negative number".to_string())?;
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err("must be a finite non-negative number".to_string())
    }
}

pub fn parse() -> Result<(Cli, Option<SessionLock>), Error> {
    let mut cmd = Cli::command();
    let cli = Cli::parse();

    let cwd = fs::canonicalize(&cli.cwd)?;

    let lock = if !cli.doctor {
        Some(
            SessionLock::acquire(&cwd).map_err(|msg| {
                cmd.error(
                    ErrorKind::ValueValidation,
                    format!("Failed to acquire session lock: {msg}"),
                )
            })?,
        )
    } else {
        None
    };

    Ok((cli, lock))
}
