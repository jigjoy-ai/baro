# ADR-0001: Put the resume fail-closed decision in a new pure module `crates/baro-tui/src/cli/resume_guard.rs`

**Status:** Accepted
**Context:** The goal requires the Resume-plus-violated-assumption decision to be a pure function separate from process spawning, modelled on `decide_launch`. `cli/launch.rs` already is that model but ADR-0001 forbids modifying it, and main.rs (4778 lines) mixes I/O with control flow. The crate has no `tests/` dir and no lib target, so a new file with an inline test module is the only testable placement.
**Decision:** Create `crates/baro-tui/src/cli/resume_guard.rs`; register it as `pub mod resume_guard;` in `crates/baro-tui/src/cli/mod.rs` (alongside `pub mod launch;` at line 2). Do NOT modify `cli/launch.rs` or `cli/detach.rs`. The module imports `crate::cli::launch::LaunchMode` and performs no I/O, no spawning, no env access. Public API, exactly:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrdState { Absent, Unreadable, Loaded }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeAssumption { PrdReadable, PrdPresent, UnfinishedStories, ResumeBranch, BranchAuthority }

impl ResumeAssumption { pub fn name(self) -> &'static str }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeGate { Proceed, Terminate { assumption: ResumeAssumption, detail: String } }

pub fn decide_resume_continuation(
    launch_mode: LaunchMode,
    prd_state: PrdState,
    has_incomplete_stories: bool,
) -> ResumeGate

pub fn resume_failure_message(assumption: ResumeAssumption, detail: &str) -> String
```

`ResumeAssumption::name` returns exactly: PrdReadable → "prd.json is readable and parses as a plan"; PrdPresent → "prd.json exists in the working directory"; UnfinishedStories → "the saved plan still has at least one unfinished story"; ResumeBranch → "the saved resume branch exists and can be checked out"; BranchAuthority → "the checked-out branch matches the saved plan's branch".

`decide_resume_continuation` rules, evaluated in this order:
1. `prd_state == Unreadable && launch_mode != LaunchMode::Explicit` → `Terminate{PrdReadable}`.
2. `launch_mode != LaunchMode::Resume` → `Proceed`.
3. `prd_state == Absent` → `Terminate{PrdPresent}`.
4. `!has_incomplete_stories` → `Terminate{UnfinishedStories}`.
5. otherwise `Proceed`.
The `detail` string is supplied by the caller through a wrapper the module owns: `decide_resume_continuation` returns `detail: String::new()` and callers use `resume_failure_message(assumption, detail)` with their own detail text; the function itself must never return `Proceed` for any input where `launch_mode == LaunchMode::Resume` and an assumption is violated.

`resume_failure_message` returns exactly:
`format!("{RESUME_ASSUMPTION_PREFIX} \"{}\" does not hold: {detail}\n{RESUME_EXITS}", assumption.name())` with, as `pub const &str` in this module:
- `RESUME_ASSUMPTION_PREFIX = "baro: resume was decided for this run, but the resume assumption"`
- `RESUME_EXITS = "Baro will not fall back to planning. Either run `baro --continue` to re-plan on top of the existing work, or delete prd.json to start a completely fresh run."`
When `detail` is empty, emit the prefix line without the trailing `: ` fragment.
**Consequences:** Every caller uses the same two consts, so the two honest exits are stated identically everywhere. `decide_launch` and its fingerprint logic are untouched; the guard only consumes its `LaunchMode`. `PrdState::Unreadable` under `LaunchMode::Explicit` proceeds, because `--continue`/`--resume` are the user's declared intent and `--resume` already hard-errors at main.rs:1273-1275. `#![allow(dead_code)]` is not needed if all items are used from main.rs; add it only if the compiler complains, matching launch.rs:6-8.
