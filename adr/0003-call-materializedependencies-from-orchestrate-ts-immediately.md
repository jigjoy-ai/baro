# ADR-0003: Call materializeDependencies from orchestrate.ts immediately after prepareOnce, not from IntegrationWorktree

**Status:** Accepted
**Context:** __run creation must not change. orchestrate.ts:833-846 is the single place that owns both repoRoot and the prepared integrationRoot, so it is the only seam that can pass both without widening IntegrationWorktree's contract.
**Decision:** In packages/baro-orchestrator/src/orchestrate.ts, after the existing `prepareOnce()` await (around orchestrate.ts:833-845) and after `const integrationRoot = …` (orchestrate.ts:846), add a single awaited call:

```ts
await materializeDependencies({ hostRoot: repoRoot, integrationRoot });
```

Wrap it in try/catch: on failure, log the error through the existing activity/warn channel used nearby in orchestrate.ts and continue — verification's own dependency refresh (verify.ts:1259-1271) remains the safety net. Do NOT edit integration-worktree.ts prepareOnce, and do NOT call materializeDependencies from finalizer.ts, run-verifier.ts, or continuous-gate-runner.ts.
**Consequences:** Exactly one call site, so agents cannot double-install. Materialization failure degrades to today's behavior rather than aborting the run.
