# ADR-0001: Create the goal branch with `git branch <name> HEAD`, without checking it out

**Status:** Accepted
**Context:** Every run that changes the host's HEAD comes from `git checkout -b` in git.rs:125-141. Both branch-creation attempts must stop changing HEAD. The public name and call signature must stay the same.
**Decision:** In crates/baro-tui/src/git.rs, create_fresh_branch_with_publish:
- Runs `git branch <branch_name> HEAD` (args ["branch", name, "HEAD"]) for the first attempt. The retry with `<branch_name>-x<hex>` uses the same form.
- Keeps the name format, retry logic and error messages, with "git checkout -b" in the text replaced by "git branch".
- Keeps push_branch_best_effort unchanged. `git push -u origin <branch>` works without a checkout.
- Returns Ok(created_name).

The signature of `pub async fn create_fresh_branch(cwd, base_name) -> BaroResult<String>` stays the same, and so does ensure_greenfield_repo.

Update the test local_only_branch_does_not_publish_to_origin to assert:
- `git branch --show-current` == "main"
- `git rev-parse <branch>` == `git rev-parse main`
- origin still has no refs.

Add a test fresh_branch_collision_retries_without_checkout. It creates the colliding name ahead of time, or calls the function twice within one second. It asserts the returned name ends with `-x<hex>`, the ref exists, and HEAD is still on main.
**Consequences:** After creation, HEAD stays on the base branch. Every caller that assumed a checkout must change (ADR-002, ADR-003). A greenfield repo still gets its root commit on its default branch first.
