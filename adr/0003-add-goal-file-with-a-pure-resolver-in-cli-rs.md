# ADR-0003: Add --goal-file with a pure resolver in cli.rs

**Status:** Accepted
**Context:** Multi-kilobyte goals break shell quoting. The positional `goal: Option<String>` (cli.rs:15-16) stays; mutual exclusion must be an error naming both, and must be unit-testable without clap process exit.
**Decision:** cli.rs adds `pub goal_file: Option<String>` with `#[arg(long = "goal-file", value_name = "PATH")]`, doc line: `Read the goal text from a file (mutually exclusive with the positional goal)`. Add in the same file:
`pub fn resolve_goal(positional: Option<&str>, goal_file: Option<&str>, read: impl FnOnce(&str) -> std::io::Result<String>) -> Result<Option<String>, String>`.
Rules: both Some -> Err("--goal-file and the positional goal argument are mutually exclusive; pass exactly one (--goal-file <path> or the positional goal)"); goal_file Some -> read, then trim trailing newlines only; empty after trim -> Err(format!("--goal-file '{path}' is empty")); read error -> Err(format!("--goal-file '{path}': {err}")); neither -> Ok(None). cli::parse() calls resolve_goal with `std::fs::read_to_string` and assigns the result into `cli.goal`, returning the Err as a CLI error before the session lock is taken. Inline #[cfg(test)] tests cover: both-given error text names both, file read, trailing-newline trim, empty file, read error.
**Consequences:** Downstream code keeps reading `cli.goal` only; no other file learns about --goal-file. Bare `baro` (neither given) is unchanged.
