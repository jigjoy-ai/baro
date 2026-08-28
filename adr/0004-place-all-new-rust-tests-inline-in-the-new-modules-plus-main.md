# ADR-0004: Place all new Rust tests inline in the new modules plus main.rs's existing test module

**Status:** Accepted
**Context:** The crate is bin-only with no `tests/` dir; the convention is `#[cfg(test)] mod tests` next to the code (launch.rs:127-266, main.rs:4425-4778), `tempfile::tempdir()` inline per test, and prd fixtures built with `executor::prd_from_review` + `executor::write_prd`. The acceptance criteria name four proofs.
**Decision:** Tests, in these exact locations:

A. `crates/baro-tui/src/cli/resume_guard.rs`, inline `mod tests`:
   - an exhaustive matrix over all `LaunchMode` × `PrdState` × `has_incomplete_stories` (3×3×2 = 18 cases) asserting the ADR-001 rule table exactly, and asserting that no case with `LaunchMode::Resume` and a violated assumption yields `ResumeGate::Proceed`;
   - a test that `resume_failure_message` output contains `ResumeAssumption::name()` for each variant, the literal `--continue`, and the literal `prd.json`.
B. `crates/baro-tui/src/prd_write_guard.rs`, inline `mod tests`:
   - `guard_fresh_plan_write(true)` is `Err` and its message contains `RESUME_EXITS`; `guard_fresh_plan_write(false)` is `Ok`;
   - a byte-identity test: `tempfile::tempdir()`, build a plan with `executor::prd_from_review` and write it with `executor::write_prd`, read the bytes, run the whole guard-failure sequence (`decide_resume_continuation` → `resume_failure_message` → `guard_fresh_plan_write(true)`), re-read the file and assert the bytes are equal.
C. `crates/baro-tui/src/main.rs`, inside the existing `mod tests` (main.rs:4425-4778): a healthy-resume regression test in the style of `a_stamped_prd_lets_decide_launch_match_the_same_goal` (main.rs:4471-4499) — write a prd.json with at least one story where `passes == false` into a tempdir, reload it from disk, feed it into `decide_launch` to get `LaunchMode::Resume`, assert `decide_resume_continuation(Resume, PrdState::Loaded, true) == ResumeGate::Proceed`, and assert the reloaded plan's `user_stories` are non-empty — i.e. the plan comes off disk with no intake/architect construction.
No new TS test; `packages/baro-orchestrator/test/runtime/resume-mode.test.ts` remains the TS coverage and must not be edited. Test function names are lowercase sentences, matching launch.rs:186-242.
**Consequences:** Tests reach production items via `use super::*` and `crate::` paths, matching main.rs:4429-4444. The byte-identity proof is a file-level assertion, not an argument from purity, so it stays honest if the guard later gains I/O. Story `writes` arrays must list the module file itself, since tests live in the same file as the code.
