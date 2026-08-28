# ADR-0002: Wire the guard into main.rs so no Resume path can reach planning, terminating with `Err(...)` and exit 1

**Status:** Accepted
**Context:** Four silent fall-throughs exist (main.rs:429-431, 1215, 1225, 1276) and three branch failures abort with messages that do not name the assumption or the exits. The crate's termination conventions are `Err(Box<dyn Error>)` → `Error: {msg}` + exit 1 (main.rs:355-366) versus `eprintln!` + `exit(2)` for argument refusals; a violated resume assumption is a run-level failure, not an argv refusal.
**Decision:** Modify only `crates/baro-tui/src/main.rs`. All new terminations use `return Err(resume_guard::resume_failure_message(assumption, detail).into());` — never `std::process::exit`, never a bare `eprintln!` fall-through.

1. main.rs:429-431: replace the swallowing read with an explicit tri-state probe local to `run_main`:
   - path does not exist → `PrdState::Absent`, prd `None`;
   - `fs::read_to_string` or `serde_json::from_str::<executor::PrdFile>` fails → `PrdState::Unreadable`, prd `None`, keep the error text as `detail`;
   - success → `PrdState::Loaded`, prd `Some(p)`.
   `has_incomplete` at 432-434 keeps its exact current definition (`user_stories.iter().any(|s| !s.passes)`), and the `decide_launch(...)` call at 435-441 keeps its exact current arguments.
2. Immediately after the existing message/`cli.resume` handling at main.rs:443-448, call `resume_guard::decide_resume_continuation(decision.mode, prd_state, has_incomplete)`; on `ResumeGate::Terminate{assumption, ..}` return the formatted error. This runs before the alternate screen (entered at main.rs:509), so the message lands on a plain terminal.
3. main.rs:1215 (`if prd_path.exists()` false): add an `else` that, when `cli.resume` is true, returns `Terminate{PrdPresent}` with detail `"prd.json is not present in <cwd>"`.
4. main.rs:1276 (`Err(error) => {}`): when `cli.resume` is false, return `Terminate{PrdReadable}` with the serde/io error text as detail. The existing `--resume` arm at 1273-1275 is rewritten to use the same message builder with `PrdReadable`.
5. main.rs:1225 gate: add an `else` branch that, when `cli.resume` is true, returns `Terminate{UnfinishedStories}` with detail `"every story in the saved plan is already marked as passing"`. The gate condition itself is unchanged.
6. main.rs:1226-1231: keep the `?` aborts but map their errors through `resume_failure_message(ResumeAssumption::ResumeBranch, &error.to_string())`, preserving the original error text as detail.
7. main.rs:1232-1236 (`branch_authority::verify_continuation_branch`): same mapping with `ResumeAssumption::BranchAuthority`.
8. After `resume::checkout_and_load_prd` succeeds (main.rs:1226-1228), re-evaluate the branch PRD with `decide_resume_continuation(LaunchMode::Resume, PrdState::Loaded, branch_prd.user_stories.iter().any(|s| !s.passes))` and terminate on `Terminate`, detail `"the plan on the resume branch has no unfinished stories"`.
Do not change `BARO_RESUME`/`BARO_CONTINUE` env writes (main.rs:1212, 1242), the `--resume` argv flag (orchestrator_client.rs:453-455), or `decide_launch`.
**Consequences:** Headless and interactive runs both exit 1 with `Error: baro: resume was decided …`; an error raised at step 2 prints on a plain terminal, errors raised at steps 3-8 print after the TUI restore at main.rs:521-535, which is the existing behaviour for `run_app` errors. `--continue` and fresh runs are unaffected because the guard returns `Proceed` for `LaunchMode::Explicit`/`Fresh` unless prd.json is unreadable. main.rs is a shared write surface: any story touching it must be sequenced, never run in parallel with another main.rs story.
