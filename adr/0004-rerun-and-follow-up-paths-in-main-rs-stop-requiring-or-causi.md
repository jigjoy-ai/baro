# ADR-0004: Rerun and follow-up paths in main.rs stop requiring or causing a checkout

**Status:** Accepted
**Context:** Rerun (main.rs:2988-3010) sets is_resume but runs checkout_existing_branch, so it would switch HEAD during a resume. Follow-up (2816-2834, 4330-4350) requires live == expected, but after a plain run the host stays on base, so every follow-up would fail.
**Decision:** main.rs rerun (2986-3010): replace the checkout and current-branch match with `branch_authority::verify_execution_branch(&exec_cwd, &full_branch).await`. On Err(e), send AppEvent::BranchError(format!("{e} Cannot rerun this checkpoint.")) and return.

main.rs follow-up blocks (2816-2834, 4330-4350): accept the live branch when it equals the expected branch (the user's own checkout) OR when git::branch_ref_exists(expected) is true. In both cases actual_full_branch = expected. Keep the existing error text for when neither holds.

Do not touch the startup --continue check at 1232-1244.
**Consequences:** Follow-ups still set BARO_CONTINUE=1. The orchestrator uses the in-place escape only when the host really is on the goal branch (ADR-005). Otherwise it integrates in __run.
