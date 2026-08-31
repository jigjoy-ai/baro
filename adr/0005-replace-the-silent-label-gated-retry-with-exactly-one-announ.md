# ADR-0005: Replace the silent label-gated retry with exactly one announced retry for run-level commands

**Status:** Accepted
**Context:** verify.ts:1086-1096 retries any command whose label matches `/\btest\b/iu`, silently, which both leaks onto story-declared tests (whose perimeter loop already retries) and hides flake from operators. The gate must stay fail-closed.
**Decision:** In `packages/baro-orchestrator/src/verification/verify.ts`:
- Retry predicate becomes `outcome.status === "failed" && isRunLevelCommand(c)`. `"skipped"` never retries. Remove `isTestCommandLabel` (verify.ts:1057-1060) and any now-dead reference to it.
- Exactly one extra attempt; the second result is authoritative — if it fails, the command fails and the gate fails. Keep populating `retriedAfterFailure: true` and `firstFailureTail` (verify.ts:63-66,1105-1107) on the final result.
- Add to `VerifyBuildOptions` (near verify.ts:125): `readonly emitActivity?: (event: BaroEvent) => void;` importing `BaroEvent` and `emit` from `../tui-protocol.js`, defaulted as `const emitActivity = options.emitActivity ?? emit;` — same injectable-with-default seam as critic-evidence.ts:105-110,919.
- Before the second attempt, emit exactly one event: `{ type: "activity", id: "_verify", kind: "warn", text: `verification command retried once: ${c.label} — first attempt failed: ${firstFailureTail}` }` (no `ok` field; matches coordination.ts:292-297). `firstFailureTail` is the first attempt's `tail`, already truncated to `TAIL_BYTES`; collapse newlines to single spaces before interpolation. No event is emitted when no retry happens.
- Do NOT thread an emitter through `continuous-gate-runner.ts`, `run-verifier.ts`, `finalizer.ts`, `verification-goal-gate.ts` or `gate-registry.ts`; they inherit the default `emit`.
**Consequences:** Story-level declared tests lose the retry they incidentally had — existing tests asserting a retried declared test must be updated to assert a single attempt. Every retry is now visible on the TUI activity stream. Combined with ADR-003 the gate remains bounded at two attempts per run-level command and fail-closed on a second failure.
