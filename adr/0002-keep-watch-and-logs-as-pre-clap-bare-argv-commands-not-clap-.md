# ADR-0002: Keep `watch` and `logs` as pre-clap bare-argv commands, not clap subcommands

**Status:** Accepted
**Context:** cli.rs has no Subcommand enum; `baro runs`/`baro stop` are already handled in main.rs:380-387 by inspecting raw argv before cli::cli::parse(). Introducing clap subcommands would force the positional `goal` into a subcommand-ambiguous position and change every existing invocation.
**Decision:** In main.rs, extend the existing raw-argv block (currently main.rs:380-387) with two more arms, matching raw_args[1]: `watch` -> cli::run_registry::run_watch(&raw_args[2..]), `logs` -> cli::run_registry::run_logs(&raw_args[2..]); both return `i32` and main exits with that code immediately, before cli::cli::parse() and before session lock acquisition. Do NOT add `#[command(subcommand)]` or a Commands enum to cli.rs. Usage: `baro watch <run-id>`, `baro logs <run-id> [--follow]`. Missing/unknown run id prints `unknown run id '<id>'` to stderr and exits 2.
**Consequences:** `watch`/`logs` never acquire the session lock and never register a run. cli.rs help text must mention the two commands in `after_help` (S1) even though clap does not model them.
