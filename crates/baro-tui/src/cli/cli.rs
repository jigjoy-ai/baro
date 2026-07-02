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

    /// Per-story tier→backend:model map, so one run can mix backends
    /// story-by-story. Example:
    ///   --tier-map "haiku=openai:MiniMax-M3,sonnet=openai:MiniMax-M3,opus=claude:opus"
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
