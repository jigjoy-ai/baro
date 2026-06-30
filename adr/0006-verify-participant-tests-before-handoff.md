# ADR-0006: Verify participant tests before handoff

**Status:** Accepted
**Context:** This goal is entirely test-focused, and the package already provides scoped scripts for participant tests and full orchestrator tests.
**Decision:** After editing tests, run `npm --workspace @baro/orchestrator test:participants`. If that passes, run `npm --workspace @baro/orchestrator test`. If production TypeScript code is changed to fix a real bug exposed by tests, also run `npm --workspace @baro/orchestrator typecheck`.
**Consequences:** A successful handoff must report the exact commands run and any failures. If a failure depends on missing local tooling or credentials, that is a design violation for participant unit tests and should be fixed by replacing live IO with deterministic fakes.
