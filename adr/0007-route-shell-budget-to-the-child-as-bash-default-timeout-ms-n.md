# ADR-0007: Route --shell-budget to the child as BASH_DEFAULT_TIMEOUT_MS, no TS change

**Status:** Accepted
**Context:** harness/environment.ts:39-51 only fills BASH_DEFAULT_TIMEOUT_MS/BASH_MAX_TIMEOUT_MS when they are undefined ('a value the user set is theirs'), so an explicitly set child env value already wins with zero TS edits, and it also gives the required precedence over an inherited BASH_DEFAULT_TIMEOUT_MS.
**Decision:** cli.rs (S1): `pub shell_budget: Option<u64>` with `#[arg(long = "shell-budget", value_name = "SECONDS")]`, doc exactly: `Per-command shell budget in seconds for story bash tools (overrides BASH_DEFAULT_TIMEOUT_MS when both are set)`. Reject 0 with `--shell-budget must be greater than 0`.
orchestrator_client.rs (S5): OrchestratorConfig gains `shell_budget_secs: Option<u64>`; in build_command, when Some(s): `cmd.env("BASH_DEFAULT_TIMEOUT_MS", (s*1000).to_string())` and `cmd.env("BASH_MAX_TIMEOUT_MS", (s*1000).max(3_600_000).to_string())`. No orchestrator argv flag is added and packages/baro-orchestrator is not modified for this requirement.
**Consequences:** When the flag is absent, inherited BASH_DEFAULT_TIMEOUT_MS keeps working exactly as today. --timeout (orchestrator_client.rs:458) remains a different, unrelated budget and must not be conflated.
