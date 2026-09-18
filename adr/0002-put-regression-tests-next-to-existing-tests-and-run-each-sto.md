# ADR-0002: Put regression tests next to existing tests and run each story's tests by file

**Status:** Accepted
**Context:** The acceptance criteria require a test per item that fails before the fix. The repo already has test/ subfolders by area and inline #[cfg(test)] modules in Rust.
**Decision:** TS tests go in packages/baro-orchestrator/test/<area>/<name>.test.ts, using node:test and node:assert/strict. Extend these existing files:
- #159: test/integration/integration-worktree.test.ts
- #136: test/planner-openai.test.ts

New TS test files:
- #144: test/execution/publish-guard.test.ts
- #141: test/operator/run-registry-base.test.ts
- #148: test/verification/node-test-script.test.ts, with fixture test/fixtures/node-test-script/package.json
- #162: test/verification/command-timing.test.ts
- #161: test/execution/write-surface-release.test.ts
- #163: test/harness/activity-idle.test.ts

Rust tests go in inline `#[cfg(test)] mod tests` inside the modified file.

A story verifies itself with `node --import tsx --test <its files>` or `cargo test -p baro-tui <filter>`. It must not run the whole repo suite.
**Consequences:** No test framework is added. Tests use temp git repos and BARO_HOME temp dirs. Tests that depend on time use small injected timeouts, never real minutes.
