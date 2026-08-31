# ADR-0002: Intercept via one pure function `usage::pre_clap_response(command, args)` called once before the six branches

**Status:** Accepted
**Context:** The six branches have three different control-flow shapes (`return run_x().await`, `?` + `return Ok(())`, `process::exit(code)`), and connect's existing help handling sits *inside* run_connect after env defaults are read (main.rs:659-670). Adding per-branch checks would give six chances to get the ordering wrong and would not be unit-testable, since run_connect/run_login end in `std::process::exit` (main.rs:652, :799). A single pure function evaluated before any dispatch is testable and orders the interception ahead of every side effect by construction.
**Decision:** In `src/cli/usage.rs`:
`pub fn pre_clap_response(command: &str, args: &[String]) -> Option<PreClapResponse>`
Semantics, exhaustively:
1. If `usage_for(command)` is `None`, return `None`.
2. Scan `args` (the tail slice, i.e. everything after the command word) left to right for the first exact token equal to `"-h"`, `"--help"`, or `"--version"`. Exact string equality only — no prefix matching, no `-hv` bundling, no `=` forms.
3. `-h`/`--help` → `Some(PreClapResponse::Help(usage_for(command).unwrap()))`; `--version` → `Some(PreClapResponse::Version)`. First match in argv order wins (so `logs x --version --help` yields Version).
4. Value-consuming flags are NOT modelled: `connect --token --help` is treated as help. This is deliberate and must be asserted by a test.
5. Return `None` when no such token is present.
In `crates/baro-tui/src/main.rs`, insert ONE block in `run_main` immediately after `let raw_args: Vec<String> = std::env::args().collect();` (currently :372) and BEFORE the existing `connect` branch at :373:
```
if let Some(cmd) = raw_args.get(1).map(|s| s.as_str()) {
    match cli::usage::pre_clap_response(cmd, &raw_args[2..]) {
        Some(cli::usage::PreClapResponse::Help(text)) => { print!("{text}"); return Ok(()); }
        Some(cli::usage::PreClapResponse::Version) => { println!("{}", cli::usage::VERSION_LINE); return Ok(()); }
        None => {}
    }
}
```
Output goes to stdout via `print!`/`println!`; return `Ok(())` (main.rs:355-367 maps that to `ExitCode::SUCCESS`) — do NOT call `std::process::exit(0)` here, matching the existing rationale comment at main.rs:501-506. Delete the now-dead inline `-h`/`--help` arm inside run_connect's loop (main.rs:706-717) so CONNECT_USAGE is the only connect help text; leave the rest of that loop, and every other branch body, untouched.
**Consequences:** All six commands are covered by one code path, so no branch can regress independently. run_connect no longer handles help; its `--help` arm removal must not disturb the `_ => i += 1` fallthrough at :718. Unknown first words still fall through to `cli::cli::parse()` unchanged.
