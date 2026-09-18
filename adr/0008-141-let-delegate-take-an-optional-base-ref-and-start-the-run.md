# ADR-0008: #141: Let delegate take an optional base ref and start the run from it in its own integration worktree

**Status:** Accepted
**Context:** RunRegistry queues runs per cwd and spawns `baro <goal> --headless --cwd`. IntegrationWorktree always branches from the host HEAD.
**Decision:** delegate tool (operator-session.ts):
- Schema adds optional `base: string`.
- When base is set, the uncommitted-files refusal is skipped, because the checkout is not touched.

RunRegistry (run-registry.ts):
- `delegate(goal, cwd, base?: string)`.
- When base is set, the run is not queued behind other runs on the same cwd; its key in the active map is `${cwd}#${runId}`.
- start() appends `--base <ref>`.

Rust:
- crates/baro-tui cli/cli.rs adds `--base <REF>` with a one-line doc.
- It is forwarded to the orchestrator config as `baseRef` alongside the prd path, and moves the lock into the run's state dir (see the #140 decision).

Orchestrator:
- Config gains `baseRef?: string`.
- IntegrationWorktree options gain `baseRef?: string`. prepareOnce resolves `git rev-parse --verify <baseRef>^{commit}` and uses it instead of hostHeadAtStart for `worktree add -b`.
- With baseRef set, syncHostCheckout returns untouched with the reason `"base_ref_run"`.

Prompt: when base is omitted, the operator prompt states: one checkout serves one run's branch, and independent goals wait until it finishes, or are delegated with base.

Test: two delegations with base=main using a fake baro bin (BARO_BIN) both start immediately with `--base main`. IntegrationWorktree with baseRef=main branches from main even after the host HEAD has advanced.
**Consequences:** Depends on #159 (the syncHostCheckout signature), #140 (per-run state and lock) and the #144 prompt story. It is ordered after all three.
