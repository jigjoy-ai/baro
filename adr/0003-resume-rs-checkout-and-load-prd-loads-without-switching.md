# ADR-0003: resume.rs checkout_and_load_prd loads without switching

**Status:** Accepted
**Context:** resume.rs:42-52 checks out the goal branch and confirms HEAD. prd.json is excluded from git, so the file on disk is the same whichever branch is checked out. The orchestrator reopens the goal branch in __run through prepare().
**Decision:** Keep the name and signature of checkout_and_load_prd in crates/baro-tui/src/resume.rs. New body:
1. branch = canonical_branch(saved)?
2. If !git::branch_ref_exists(cwd, &branch)?, return Err("cannot establish resume branch '<branch>': branch does not exist").
3. Read cwd.join("prd.json"), parse it, check branchName against the branch, and write the normalized name back, exactly as at lines 54-67.

Remove the calls to checkout_existing_branch and get_current_branch. Update the doc comment to one line saying no checkout happens. If checkout_existing_branch in git.rs has no callers left, delete it.

In main.rs 1266-1285 (auto-resume), replace get_current_branch + verify_continuation_branch with verify_execution_branch(&cwd, &prd.branch_name). Set app.branch_name and app.continuation_branch from prd.branch_name.

The refined resume at main.rs:2683-2698 keeps calling checkout_and_load_prd and gains no checkout.
**Consequences:** Resuming never changes HEAD. BARO_CONTINUE is not set on resume, so the orchestrator takes the worktree path and prepare() reuses the existing goal branch.
