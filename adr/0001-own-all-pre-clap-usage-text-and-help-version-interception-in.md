# ADR-0001: Own all pre-clap usage text and help/version interception in a new `src/cli/usage.rs` module

**Status:** Accepted
**Context:** There is no shared usage-text mechanism today: the epilogue is an inline literal at cli/cli.rs:12 and connect has its own inline help block at main.rs:706-717. Putting the new text in main.rs would leave the epilogue duplicating it; putting it in cli/cli.rs would mix clap metadata with raw-argv logic. The crate is binary-only, so the module must be declared inside the bin target to be unit-testable.
**Decision:** Create `crates/baro-tui/src/cli/usage.rs` and add `pub mod usage;` to `crates/baro-tui/src/cli/mod.rs`. This file is the SINGLE owner of pre-clap usage text and of the help/version decision. It exports exactly:
- `pub const VERSION_LINE: &str` — see ADR on version format.
- Six per-command usage consts: `CONNECT_USAGE`, `LOGIN_USAGE`, `RUNS_USAGE`, `STOP_USAGE`, `WATCH_USAGE`, `LOGS_USAGE` (`&'static str`, each ending with a trailing `\n`).
- `pub const AFTER_HELP: &str` — the clap epilogue (see the epilogue ADR).
- `pub const PRE_CLAP_COMMANDS: [&str; 6] = ["connect", "login", "runs", "stop", "watch", "logs"];`
- `pub fn usage_for(command: &str) -> Option<&'static str>` mapping those six names to their const; `None` otherwise.
- `pub enum PreClapResponse { Help(&'static str), Version }` and the decision fn (next ADR).
Do NOT create a new top-level `mod` in main.rs and do NOT put any of this text in main.rs or cli/cli.rs. No new dependency: text is plain `&'static str` built with `concat!`.
**Consequences:** Every agent edits one file for wording. cli/cli.rs and main.rs both import from `crate::cli::usage`. Because the crate has no lib target, tests for this module must be an inline `#[cfg(test)] mod tests` in usage.rs itself.
