# ADR-0002: Narrow branch_authority checks to 'goal ref exists'

**Status:** Accepted
**Context:** verify_execution_branch (branch_authority.rs:18-34) requires `git branch --show-current` == expected, which is impossible once no checkout happens. There is no base-branch value anywhere in main.rs, so the host branch cannot be checked against a base. The recorded assumption allows this narrowing.
**Decision:** In crates/baro-tui/src/branch_authority.rs:

Keep the signature `pub(crate) async fn verify_execution_branch(cwd: &Path, expected: &str) -> Result<(), String>`. New behavior:
1. Trim `expected`. Reject an empty name or "HEAD".
2. Run `git show-ref --verify --quiet refs/heads/<expected>` in cwd. On non-zero exit or spawn failure, return Err("Branch verification failed: goal branch '<expected>' does not exist. Refusing to start the executor.").
3. Do not read or compare the current branch.

Add a helper `pub(crate) async fn branch_ref_exists(cwd: &Path, name: &str) -> Result<bool, String>` in crates/baro-tui/src/git.rs. branch_authority and resume.rs both use it.

verify_continuation_branch stays unchanged; it still covers the explicit --continue path (main.rs:1240). Remove the private helper verify_execution_branch_name and its tests, or keep it only if other code still calls it.

Add a tokio test: in a temp repo on main, create branch baro/x with `git branch`. Verification of baro/x must succeed while HEAD is on main, and verification of baro/missing must fail.
**Consequences:** The guard no longer catches a host checkout that is on the wrong branch. The orchestrator guards that case instead (ADR-005). Flag this for code-owner review. The call sites at main.rs:2851, 4365 and 4440 do not change.
