# ADR-0004: #140: Keep run state in ~/.baro/runs/<runId>/ and offer discard or fresh start when the saved branch is gone

**Status:** Accepted
**Context:** prd.json lives in the checkout and resume errors out when the saved branch is missing. The pointer is optional ("at most a pointer"), so choosing no pointer is simplest and leaves nothing behind.
**Decision:** Run id: BARO_RUN_ID if set, else `<unix_ms>-<8 hex of stable hash of canonical cwd>`. It is generated in Rust in a new module crates/baro-tui/src/run_state.rs.

State directory: baro_home()/runs/<runId>/, containing:
- prd.json
- run.json: {"runId": string, "checkout": canonical cwd, "branch": string, "status": "active"|"finished"}

Wiring:
- Rust passes <stateDir>/prd.json as the PRD path wherever it is handed to the orchestrator today (orchestrator_client.rs:577), and uses it wherever main.rs/executor.rs/resume.rs build cwd.join("prd.json"). No pointer file is written to the checkout.
- run_state.rs exports:
  - `create_run(cwd, branch) -> RunState`
  - `find_resumable(cwd) -> Option<RunState>`: scans runs/*/run.json for checkout==cwd with status != finished, newest first.
  - `mark_finished(&RunState)`
  - `discard(&RunState)`: removes the directory.
- On any run end, success or failure, the Rust caller calls mark_finished only on success. It must leave no file in the checkout except what git tracks.
- baro.lock stays at <cwd>/baro.lock and is removed on drop. The exception is when --base is given (#141): the lock is then <stateDir>/baro.lock.
- Legacy: a <cwd>/prd.json with unfinished stories and no run state keeps today's behaviour.

Resume:
- In resume.rs, add `pub enum ResumeDetection { None, Resumable(RunState), MissingBranch { run_id: String, branch: String } }` and `pub fn detect_resume(cwd) -> ResumeDetection`.
- MissingBranch must not return Err.
- Interactive mode shows: `Saved run <id> targets branch '<branch>', which no longer exists. [d] discard saved run  [f] discard and start fresh`.
- Headless mode with a goal: discard and start fresh.
- Headless mode without a goal: print that message, plus `rerun with a goal to start fresh`, and exit 0.
- Put the message text in `pub fn missing_branch_offer(run_id, branch) -> String`.

Rust tests:
- A finished run leaves `git status --porcelain --ignored` free of prd.json and baro.lock.
- detect_resume returns MissingBranch carrying the id and branch, and missing_branch_offer contains both options.
**Consequences:** The TS orchestrator is unchanged apart from receiving a different prdPath. Remove prd.json from the git.ts:516-525 artifact list only if the list fails to handle a path outside the checkout. The dead-code resume_guard.rs stays untouched.
