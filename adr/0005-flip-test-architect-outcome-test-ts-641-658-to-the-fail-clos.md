# ADR-0005: Flip test/architect-outcome.test.ts:641-658 to the fail-closed expectation and re-anchor the benign-strip case on a non-denylisted field

**Status:** Accepted
**Context:** That test currently asserts the exact behavior this goal removes: a forged top-level sessionId is stripped with the note `: dropped unexpected field "sessionId"` and the outcome accepted. It directly contradicts run-architect-outcome.test.ts:437-449. Leaving it untouched makes the change impossible; deleting it loses the drift-tolerance regression guard the goal explicitly protects.
**Decision:** Edit packages/baro-orchestrator/test/architect-outcome.test.ts in place, at the existing case around :641-658:

- Rewrite that case to assert rejection: `parseArchitectOutcome(JSON.stringify({ ...ready(), sessionId: "model-owned" }))` throws, the thrown error is an ArchitectOutcomeContractError, and its message matches BOTH `/exact v1 schema/` and `/model output may not carry host-assigned correlation/` and contains the literal `"sessionId"`. Also assert no ContractNote was emitted to the sink for that call (drift notes must not fire on rejection).
- Add, immediately after it, the benign-tolerance regression case using a field that is NOT on the denylist: `{ ...ready(), vibes: "good" }` must be ACCEPTED and must emit exactly one note `{ severity: "warn", kind: "stripped_unexpected_field", path: "", detail: ': dropped unexpected field "vibes"' }`.

No other case in this file changes. Do not touch packages/baro-orchestrator/test/run-architect-outcome.test.ts at all — not its content, not its formatting.
**Consequences:** This is the only pre-existing green assertion the change is permitted to invert, and the PR description must call it out with its old and new expectation. Because `vibes` replaces `sessionId` as the drift fixture, the strip-with-note path stays covered and a future regression in tolerance still fails a test.
