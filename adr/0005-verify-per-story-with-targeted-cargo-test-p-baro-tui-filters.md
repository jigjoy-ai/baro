# ADR-0005: Verify per-story with targeted `cargo test -p baro-tui` filters and run no repository-wide suite

**Status:** Accepted
**Context:** The goal states repository-wide suite commands are rejected by the shell and each story verifies only its own perimeter; adr/0013-test-placement-and-per-story-verification-commands.md is the existing convention for per-story commands. Dependencies are already installed and shared into the worktree.
**Decision:** Per-story verification commands, run from the repository root, no install step:
- resume_guard story: `cargo test -p baro-tui cli::resume_guard`
- prd_write_guard story: `cargo test -p baro-tui prd_write_guard`
- main.rs wiring story: `cargo test -p baro-tui tests::` plus `cargo test -p baro-tui cli::launch` (proves `decide_launch` behaviour is unchanged)
Every story additionally runs `cargo build -p baro-tui` to prove the crate compiles after its edit. No story runs a bare `cargo test`, `npm test` at the repo root, or any repository-wide gate; no story reproduces, counts, or re-verifies the run-level gate. If a targeted command fails under machine load, one isolated rerun of that same command is permitted and the isolated pass decides.
**Consequences:** TS packages are untouched by every story, so no npm command is part of any perimeter. A story that cannot make its filter match must fix the test module path rather than widen the command.
