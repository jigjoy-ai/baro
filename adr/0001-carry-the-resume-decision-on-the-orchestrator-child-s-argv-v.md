# ADR-0001: Carry the resume decision on the orchestrator child's argv via an `is_resume` field on OrchestratorConfig

**Status:** Accepted
**Context:** Resume reaches the child only through the process-global `set_var("BARO_RESUME","1")` at main.rs:1242, which is invisible at the spawn site and leaks to every later orchestrator in the process. The goal forbids scattering more env writes. `build_command` (orchestrator_client.rs:431) is the single argv assembly point and is already covered by an inline test module (:556). Alternative rejected: reading the env var inside `build_command` — that keeps the hidden global and is not the explicit single input the goal requires.
**Decision:** In crates/baro-tui/src/orchestrator_client.rs:
1. Add `pub is_resume: bool` to `OrchestratorConfig` (place it next to the other plain bool config fields; keep it a plain `bool`, no Option).
2. In `build_command`, immediately after the `--cwd` arg (currently orchestrator_client.rs:449) add:
   `if cfg.is_resume { cmd.arg("--resume"); }`
   Emit the bare flag only — no value, no `=` form, exactly once, and never when `is_resume` is false. Do NOT set `BARO_RESUME` inside `build_command`.
In crates/baro-tui/src/main.rs:
3. Add a final parameter `is_resume: bool` to `fn spawn_executor(...)` (main.rs:4192-4199) and set `is_resume` in the `OrchestratorConfig` literal at main.rs:4282-4313 from it.
4. At every `spawn_executor` call site (including main.rs:4078 in `confirm_and_execute`) pass the resume state already in scope: `self.is_resume` / `app.is_resume` (the field set at main.rs:1237). At any call site where no `App` is in scope, pass `std::env::var("BARO_RESUME").as_deref() == Ok("1")` rather than a hardcoded `false`.
5. Leave main.rs:1225-1242 (`app.is_resume = true` and the `set_var("BARO_RESUME","1")`) exactly as-is; update only the comment at main.rs:1238-1241 if it becomes inaccurate.
Do not touch `crates/baro-tui/src/cli/launch.rs` (`decide_launch`) or `crates/baro-tui/src/cli/detach.rs`.
**Consequences:** Both launch paths (bare headless inferred-resume and TUI `app.is_resume`) funnel through the same field, so no path can silently lose resume. Adding a struct field breaks every `OrchestratorConfig` literal in the crate, including ones inside `#[cfg(test)]` modules — all must be updated in the same story. `--resume` must remain a parsed (non-fatal) flag in cli.ts, which ADR-002 guarantees.
