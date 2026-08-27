# ADR-0002: Prove the `--resume` argv marker with an inline Rust test on build_command

**Status:** Accepted
**Context:** Acceptance requires a Rust test asserting the child's spawn arguments carry `--resume` when the decision was Resume, following the `decide_launch` pure-test precedent (launch.rs:95-125, tests :186-242). The crate has no `tests/` dir and no dev-dependencies (ADR-0001:4), and `build_command` is already exercised by the existing module at orchestrator_client.rs:556-560.
**Decision:** Add two tests to the existing `#[cfg(test)] mod tests` in crates/baro-tui/src/orchestrator_client.rs, reusing that module's existing config/`ScriptEntry` fixture helper (do not introduce a new fixture module, no new dependency):
- `a_resume_launch_puts_the_resume_flag_on_the_child_argv`: build a config with `is_resume: true`, call `build_command`, collect `cmd.as_std().get_args()` into `Vec<String>` (the existing tests' inspection style) and assert the vector contains exactly one `"--resume"`.
- `a_fresh_launch_leaves_the_resume_flag_off`: same with `is_resume: false`, assert no element equals `"--resume"`.
No process is spawned and no env var is read or written by these tests.
**Consequences:** Verification for this story is `cargo test -p baro-tui orchestrator_client::tests::` plus `cargo build -p baro-tui`; it must not run the repo-wide suite. Because these tests read `get_args()`, any future reordering of flags stays safe (membership, not position).
