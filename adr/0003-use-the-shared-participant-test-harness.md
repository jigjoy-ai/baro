# ADR-0003: Use the shared participant test harness

**Status:** Accepted
**Context:** Existing participant tests already share `packages/baro-orchestrator/test/participants/helpers.ts` for captured environments, fake sources, temporary directories, and stdout capture. Duplicated ad hoc mocks would make event assertions inconsistent across participants.
**Decision:** Reuse `source(agentId)`, `captureEnv()`, `joinWithCapture(participant)`, `withTempDir(prefix, fn)`, and `captureStdout(fn)` from `packages/baro-orchestrator/test/participants/helpers.ts` whenever a new test needs those behaviors. If a helper gap appears, extend this same helper file with a small generic helper; do not create participant-specific helper modules unless the helper is private to one test file.
**Consequences:** New tests should assert against captured `SemanticEvent` instances using factory guards such as `AgentState.is(event)`, `StoryResult.is(event)`, `Coordination.is(event)`, and parse forwarder stdout as `BaroEvent` JSON. Shared test setup stays discoverable in one file.
