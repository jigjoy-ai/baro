use std::{fs};

use clap::{CommandFactory, Error, Parser, error::ErrorKind};

use crate::cli::session::SessionLock;

#[derive(Parser)]
#[command(
    name = "baro",
    version,
    about = "AI-powered project execution",
    after_help = crate::cli::usage::AFTER_HELP
)]
pub struct Cli {
    /// Project goal (if omitted, shows welcome screen)
    pub goal: Option<String>,

    /// Read the goal text from a file (mutually exclusive with the positional goal)
    #[arg(long = "goal-file", value_name = "PATH")]
    pub goal_file: Option<String>,

    /// Run in the background and print the run id immediately
    #[arg(long)]
    pub detach: bool,

    /// Per-command shell budget in seconds for story bash tools (overrides BASH_DEFAULT_TIMEOUT_MS when both are set)
    #[arg(long = "shell-budget", value_name = "SECONDS", value_parser = parse_shell_budget)]
    pub shell_budget: Option<u64>,

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
    #[arg(long)]
    pub parallel: Option<u32>,

    /// Coordination engine: collective event-bus agents (default) or legacy Conductor compatibility.
    #[arg(long, value_parser=["legacy", "collective"], env = "BARO_COORDINATION", default_value = "collective")]
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

    /// Explicitly enable the run-local conversation participant (already on in collective mode).
    #[arg(long)]
    pub with_dialogue: bool,

    /// Text-only backend for the conversation participant.
    #[arg(long, value_parser=["claude", "openai", "codex"], env = "BARO_DIALOGUE_LLM")]
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
    pub with_critic: bool,

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
    ///   hybrid           — Architect/Planner/Critic/Surgeon on Claude,
    ///                      Story on Codex; phase overrides win.
    ///   jigjoy           — hosted baro gateway holding the upstream keys
    ///                      (JIGJOY_API_KEY; URL via BARO_JIGJOY_URL).
    #[arg(long, default_value="claude", value_parser=["claude", "openai", "codex", "opencode", "pi", "hybrid", "jigjoy"])]
    pub llm: String,

    /// Base URL for all OpenAI-routed calls instead of api.openai.com,
    /// for OpenAI-compatible providers (OpenRouter, vLLM, Ollama, ...).
    #[arg(long)]
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

fn parse_shell_budget(raw: &str) -> Result<u64, String> {
    let value = raw
        .parse::<u64>()
        .map_err(|_| "must be a whole number of seconds".to_string())?;
    if value == 0 {
        return Err("--shell-budget must be greater than 0".to_string());
    }
    Ok(value)
}

/// Resolve the goal text from the positional argument or --goal-file.
/// `read` is injected so the rules stay testable without touching the filesystem.
pub fn resolve_goal(
    positional: Option<&str>,
    goal_file: Option<&str>,
    read: impl FnOnce(&str) -> std::io::Result<String>,
) -> Result<Option<String>, String> {
    match (positional, goal_file) {
        (Some(_), Some(_)) => Err(GOAL_SOURCE_CONFLICT.to_string()),
        (_, Some(path)) => {
            let text = read(path).map_err(|err| format!("--goal-file '{path}': {err}"))?;
            if text.trim().is_empty() {
                return Err(format!("--goal-file '{path}' is empty"));
            }
            Ok(Some(text.trim_end_matches(['\n', '\r']).to_string()))
        }
        (positional, None) => Ok(positional.map(str::to_string)),
    }
}

const GOAL_SOURCE_CONFLICT: &str = "--goal-file and the positional goal argument are mutually exclusive; pass exactly one (--goal-file <path> or the positional goal)";

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
    let mut cli = Cli::parse();

    cli.goal = resolve_goal(cli.goal.as_deref(), cli.goal_file.as_deref(), |path| {
        fs::read_to_string(path)
    })
    .map_err(|msg| cmd.error(ErrorKind::ValueValidation, msg))?;

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

#[cfg(test)]
mod tests {
    use super::*;

    fn unreachable_read(_path: &str) -> std::io::Result<String> {
        panic!("goal file must not be read");
    }

    #[test]
    fn resolve_goal_rejects_both_sources_naming_both() {
        let err = resolve_goal(Some("ship it"), Some("goal.md"), unreachable_read).unwrap_err();
        assert_eq!(
            err,
            "--goal-file and the positional goal argument are mutually exclusive; pass exactly one (--goal-file <path> or the positional goal)"
        );
    }

    #[test]
    fn resolve_goal_reads_file_and_trims_trailing_newlines() {
        let body = "line with 'quotes' and $vars\n".repeat(200);
        assert!(body.len() > 4096);
        let expected = body.trim_end_matches('\n').to_string();
        let resolved = resolve_goal(None, Some("goal.md"), |path| {
            assert_eq!(path, "goal.md");
            Ok(format!("{body}\n\n"))
        })
        .unwrap();
        assert_eq!(resolved, Some(expected));
    }

    #[test]
    fn resolve_goal_rejects_empty_file() {
        let err = resolve_goal(None, Some("goal.md"), |_| Ok("  \n\t\n".to_string())).unwrap_err();
        assert_eq!(err, "--goal-file 'goal.md' is empty");
    }

    #[test]
    fn resolve_goal_surfaces_read_error() {
        let err = resolve_goal(None, Some("missing.md"), |_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no such file",
            ))
        })
        .unwrap_err();
        assert_eq!(err, "--goal-file 'missing.md': no such file");
    }

    #[test]
    fn resolve_goal_passes_positional_through_and_defaults_to_none() {
        assert_eq!(
            resolve_goal(Some("ship it"), None, unreachable_read).unwrap(),
            Some("ship it".to_string())
        );
        assert_eq!(resolve_goal(None, None, unreachable_read).unwrap(), None);
    }

    #[test]
    fn shell_budget_parses_seconds_and_rejects_zero() {
        let cli = Cli::try_parse_from(["baro", "--shell-budget", "120", "goal"]).unwrap();
        assert_eq!(cli.shell_budget, Some(120));
        assert_eq!(
            Cli::try_parse_from(["baro", "goal"]).unwrap().shell_budget,
            None
        );

        let err = match Cli::try_parse_from(["baro", "--shell-budget", "0", "goal"]) {
            Ok(_) => panic!("--shell-budget 0 must be rejected"),
            Err(err) => err,
        };
        assert!(
            err.to_string()
                .contains("--shell-budget must be greater than 0"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn detach_combines_with_resume_and_continue() {
        let resumed = Cli::try_parse_from(["baro", "--detach", "--resume"]).unwrap();
        assert!(resumed.detach && resumed.resume);

        let continued = Cli::try_parse_from(["baro", "--detach", "--continue"]).unwrap();
        assert!(continued.detach && continued.continue_run);

        let with_goal_file =
            Cli::try_parse_from(["baro", "--detach", "--goal-file", "goal.md"]).unwrap();
        assert!(with_goal_file.detach);
        assert_eq!(with_goal_file.goal_file.as_deref(), Some("goal.md"));
    }

    #[test]
    fn long_help_documents_precedence_and_replanning_rules() {
        let help = Cli::command().render_long_help().to_string();
        assert!(
            help.contains(
                "Per-command shell budget in seconds for story bash tools (overrides BASH_DEFAULT_TIMEOUT_MS when both are set)"
            ),
            "missing --shell-budget precedence line:\n{help}"
        );
        assert!(
            help.contains("--resume never re-plans; --continue always re-plans."),
            "missing re-planning rule:\n{help}"
        );
        assert!(help.contains("baro watch <run-id>"), "missing watch command");
        assert!(help.contains("baro logs <run-id> [--follow]"), "missing logs command");
        assert!(
            help.contains("Read the goal text from a file (mutually exclusive with the positional goal)"),
            "missing --goal-file help"
        );
    }

    #[test]
    fn long_help_contains_summaries() {
        use crate::cli::usage;

        let help = Cli::command().render_long_help().to_string();
        for summary in [
            usage::CONNECT_SUMMARY,
            usage::LOGIN_SUMMARY,
            usage::RUNS_SUMMARY,
            usage::STOP_SUMMARY,
            usage::WATCH_SUMMARY,
            usage::LOGS_SUMMARY,
        ] {
            assert!(help.contains(summary), "epilogue drifted from {summary}:\n{help}");
        }
    }
}
