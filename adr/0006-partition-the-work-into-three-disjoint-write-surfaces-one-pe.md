# ADR-0006: Partition the work into three disjoint write surfaces, one per story

**Status:** Accepted
**Context:** The run constraint requires every story to declare an exact, non-overlapping `writes` array, and the three defects are independent. The board test must not share a file with other stories, so it gets its own new test file rather than appending to collective-board.test.ts.
**Decision:** Exactly three parallel stories, with these exhaustive `writes` arrays (repo-relative), and no story may write a file outside its own list:
- Story A (replan admission): `packages/baro-orchestrator/src/events/runtime-graph.ts`, `packages/baro-orchestrator/src/runtime/runtime-replan.ts`, `packages/baro-orchestrator/test/runtime-graph/runtime-replan-board.test.ts`.
- Story B (spawn re-announcement): `packages/baro-orchestrator/src/execution/collective-board.ts`, `packages/baro-orchestrator/test/execution/collective-board-spawn-surface-announce.test.ts` (NEW file).
- Story C (containment guard): `packages/baro-orchestrator/src/planning/adapters/codebase-tools.ts`, `packages/baro-orchestrator/test/story-tool-containment.test.ts`.
Shared/off-limits: no story edits package.json, scripts/test-lanes.mjs, test/execution/helpers.ts, src/runtime-graph/runtime-replan-coordinator.ts, src/harness/openai/story-agent.ts, src/market/story-factory.ts, or anything under crates/, desktop/, node_modules/, target/. No new dependencies may be added; use node:test + node:assert/strict and the existing helpers only. If docs/collective-runtime.md needs the new rejection code (see ADR on the union), that file belongs to Story A alone.
**Consequences:** The three surfaces are disjoint under exact-path comparison, so the new replan disjointness gate would itself accept this plan. Story B creating a new test file avoids contention on collective-board.test.ts.
