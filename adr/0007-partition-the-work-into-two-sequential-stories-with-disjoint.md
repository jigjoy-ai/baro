# ADR-0007: Partition the work into two sequential stories with disjoint writes arrays

**Status:** Accepted
**Context:** The run requires every story to declare an exact repo-relative writes array, and the shared module must exist before call sites can reference ContractAuthorityFieldError. Splitting by file rather than by concern keeps the write sets disjoint so no two agents edit the same file.
**Decision:** Story 1 (shared module + its tests), writes exactly:
- packages/baro-orchestrator/src/contract/contract-normalization.ts
- packages/baro-orchestrator/test/contract/contract-normalization.test.ts

Story 2 (call-site wiring + affected tests), runs after Story 1, writes exactly:
- packages/baro-orchestrator/src/planning/domain/architect-outcome.ts
- packages/baro-orchestrator/src/planning/domain/architect-obligation-segments.ts
- packages/baro-orchestrator/test/architect-outcome.test.ts
- packages/baro-orchestrator/test/planning/domain/architect-obligation-segments.test.ts

No story writes packages/baro-orchestrator/test/run-architect-outcome.test.ts, scripts/run-architect.ts, src/goal/goal-constraint-appendix.ts, src/planning/adapters/architect-bus-session.ts, any file under crates/, or any package manifest. If Story 2 finds it cannot avoid editing scripts/run-architect.ts, it must stop rather than edit it.
**Consequences:** Story 1 alone changes observable behavior for goal-constraint-appendix.ts and architect-bus-session.ts callers (they inherit the guard through normalizeRecordKeys without edits), so Story 1 must not be merged expecting no downstream effect; Story 2 is what restores the `exact v1 schema` phrase on the outcome path. Ordering is mandatory: running Story 2 first leaves an unresolved import.
