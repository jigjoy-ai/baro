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

    /// Per-story timeout in seconds. Omit for an effort-scaled default
    /// (--effort max ≈ 25 min, xhigh ≈ 20, high ≈ 15, else 10); pass a
    /// value to override it absolutely — shorter OR longer.
    #[arg(long)]
    pub timeout: Option<u64>,

    /// Override model for all phases. For `--llm claude` the valid
    /// values are opus / sonnet / haiku; for openai / codex / opencode
    /// the value is passed through verbatim (e.g.
    /// `anthropic/claude-sonnet-4`, `openai/gpt-4o`,
    /// `lmstudio/qwen3-coder`). Validation is per-backend at runtime
    /// rather than a fixed clap allow-list, so non-Claude backends can
    /// name any provider/model their CLI understands.
    #[arg(long = "model", short = 'm')]
    pub model: Option<String>,

    /// Effort level for spawned `claude` processes (the Architect,
    /// Planner, and Story agents on the `claude` backend). Higher =
    /// more thinking per turn at more tokens. `max` matches Claude
    /// Code's max-effort dynamic-workflows mode. Default: high.
    #[arg(long, value_parser=["low", "medium", "high", "xhigh", "max"], default_value="high")]
    pub effort: String,

    /// Disable model routing (equivalent to --model opus)
    #[arg(long = "no-model-routing")]
    pub no_model_routing: bool,

    /// Enable the live Critic: evaluates each agent turn against its
    /// acceptance criteria via `claude --model haiku` and injects
    /// corrective feedback when a turn doesn't satisfy them. Default: ON.
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

    /// Disable the Surgeon: observes terminal story failures and proposes
    /// replans (split / prereq / rewire) so failed work gets done in a
    /// different shape rather than dropped. Default: ON.
    #[arg(long)]
    pub no_surgeon: bool,

    /// (deprecated) Surgeon is on by default; use --no-surgeon to opt out.
    #[arg(long, hide = true)]
    with_surgeon: bool,

    /// Use deterministic Surgeon (skip-only) instead of the LLM-driven
    /// replanner. The LLM Surgeon is on by default — it produces richer
    /// replans (split, prereq, rewire) at the cost of an Opus call per
    /// terminal failure.
    #[arg(long)]
    pub no_surgeon_llm: bool,

    /// (deprecated) LLM Surgeon is on by default; use --no-surgeon-llm to opt out.
    #[arg(long, hide = true)]
    surgeon_use_llm: bool,

    /// Model for the Surgeon LLM. Default: "opus".
    #[arg(long)]
    pub surgeon_model: Option<String>,

    /// Model used for the Architect phase. Overrides the routed default
    /// (opus) and any `--llm`-side default (gpt-5.5). Beaten only by
    /// the global `--model` flag, which forces every phase to one model.
    #[arg(long)]
    pub architect_model: Option<String>,

    /// Model used for the Planner phase. Same precedence rules as
    /// `--architect-model`. Default: routed (opus) for Claude, gpt-5.4
    /// for OpenAI.
    #[arg(long)]
    pub planner_model: Option<String>,

    /// Model used by the Critic. Default: "haiku".
    #[arg(long)]
    pub critic_model: Option<String>,

    /// Model used for every Story Agent in the run. Same precedence
    /// rules. Default: routed (opus) for Claude, gpt-5.5 for OpenAI.
    #[arg(long)]
    pub story_model: Option<String>,

    /// Per-story tier→backend:model map. Binds the planner's blast-radius
    /// tiers to concrete backends so ONE run can mix claude/openai/codex
    /// story-by-story (cheap stories on one model, cross-cutting stories
    /// on another). Example:
    ///   --tier-map "haiku=openai:MiniMax-M3,sonnet=openai:MiniMax-M3,opus=claude:opus"
    /// Without this, per-story tiers run on the phase backend as before.
    #[arg(long = "tier-map")]
    pub tier_map: Option<String>,

    /// Register a named OpenAI-compatible endpoint, `name=url` (repeatable).
    /// Reference it from a route as `openai:<model>@<name>`, so one run can
    /// hit several OpenAI-compatible endpoints (e.g. MiniMax + real OpenAI):
    ///   --openai-endpoint minimax=https://api.minimax.io/v1
    ///   --tier-map "haiku=openai:MiniMax-M3@minimax,opus=claude:opus"
    /// The API key per endpoint is read from `BARO_OPENAI_KEY_<NAME>` (else
    /// `OPENAI_API_KEY`) — never passed on the command line.
    #[arg(long = "openai-endpoint")]
    pub openai_endpoint: Vec<String>,

    /// Seconds to wait between successive story spawns inside the same
    /// DAG level. Gives Librarian a window to capture and broadcast
    /// the first agent's exploratory tool calls so its peers don't
    /// repeat the same Reads/Greps. Default: 10. Set to 0 to disable.
    #[arg(long = "intra-level-delay")]
    pub intra_level_delay: Option<u64>,

    /// Run a self-diagnostic and exit. Verifies the `claude` CLI is on
    /// PATH, can return a version, can complete a trivial authenticated
    /// call, plus checks for `gh` and a writable audit directory.
    /// Use this when a baro run fails before any agents start.
    #[arg(long)]
    pub doctor: bool,

    /// Quick mode for trivial goals. Skips the Architect phase, forces
    /// the Planner to emit exactly one story, and disables Critic +
    /// Surgeon. Use this when you'd otherwise type your prompt directly
    /// into Claude Code: `baro --quick "fix the typo on line 42"`.
    /// One agent, tight scope, no design-document overhead.
    #[arg(long)]
    pub quick: bool,

    /// Continue a previous run on the CURRENT branch instead of opening a new
    /// one — the follow-up lands on the existing PR. The branch already holds
    /// the prior work, which baro re-reads as context.
    /// `baro --continue "now add error handling"`
    #[arg(long = "continue")]
    pub continue_run: bool,

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
    ///   jigjoy           — hosted preset: every phase talks to the
    ///                      baro gateway (an OpenAI-compatible proxy)
    ///                      that holds the upstream keys and routes
    ///                      planner/architect/surgeon to a strong model
    ///                      and story/critic to a cheap one. Supply only
    ///                      your hosted key via JIGJOY_API_KEY; override
    ///                      the gateway URL with BARO_JIGJOY_URL.
    #[arg(long, default_value="claude", value_parser=["claude", "openai", "codex", "opencode", "pi", "hybrid", "jigjoy"])]
    pub llm: String,

    /// Custom base URL for OpenAI-compatible API endpoints. When set,
    /// all OpenAI-routed calls (Architect, Planner, Story, Critic,
    /// Surgeon) are sent to this URL instead of api.openai.com.
    /// Useful for providers that expose an OpenAI-compatible API:
    /// Xiaomi MiMo, OpenRouter, vLLM, Ollama, etc. Can also be set
    /// via the OPENAI_BASE_URL environment variable (flag wins).
    #[arg(long, env = "OPENAI_BASE_URL")]
    pub openai_base_url: Option<String>,

    /// Per-phase overrides. Each accepts claude | openai | codex | opencode and
    /// wins over `--llm` (including the `hybrid` preset) for that one
    /// phase. Useful for surgical tuning: e.g. `--llm hybrid
    /// --critic-llm claude` for a hybrid run that uses Claude for
    /// Critic instead of Codex.
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

    /// Disable semantic memory (MemoryLibrarian). Uses tag-based
    /// Librarian instead. Semantic memory uses ONNX embeddings for
    /// better context matching between agents. Default: ON.
    #[arg(long)]
    pub no_memory: bool,

    /// Run without the TUI: plan and execute the goal autonomously,
    /// auto-confirming the plan, and stream the orchestrator's event
    /// JSON to stdout. For CI / automation / remote runners. Requires a
    /// goal argument.
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
