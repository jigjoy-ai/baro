# ADR-0005: Limit the re-serialization sweep to orchestrate.ts and leave every other site unchanged

**Status:** Accepted
**Context:** A repository sweep for field-by-field handling of VerifyCommandResult found several sites. Without an explicit verdict per site, agents would 'fix' projections that are intentionally lossy and change unrelated behavior.
**Decision:** Only `src/orchestrate.ts:1984-1989` is a lossy copy of an existing result and is fixed (per the previous decision). Leave all of the following unchanged, and record this verdict in the PR description:
- `src/verification/verify.ts:1097-1108` — the producer; it constructs results, it does not re-serialize them.
- `src/verification/run-verifier.ts:158-165` and `src/integration/finalizer.ts:1072-1077` — synthetic entries built from an error/verdict, with no source result to copy from.
- `src/integration/finalizer.ts:1083-1086` (`{cmd, tail}`), `:904` (PR-body string), `src/verification/continuous-gate-runner.ts:195-199` (`{label, passed, detail}`), `src/execution/planner-awareness-runner.ts:106`, `src/execution/forwarders/coordination.ts:151` — deliberate narrowing into different, non-VerifyCommandResult shapes.
- `src/integration/finalizer.ts:1067`, `src/verification/verification-goal-gate.ts:174-182`, `src/goal/goal-invariant-review-evidence.ts:71-76` — already field-preserving spreads/pass-throughs.
No agent edits `src/verification/verify.ts` or `src/events/verification.ts` in this run.
**Consequences:** The sweep is closed with a documented result; no story needs to open files outside its declared writes. If a future field must reach the finalizer's synthetic entries, that is a separate change.
