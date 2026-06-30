# ADR-0003: Share a small participant test harness

**Status:** Accepted
**Context:** Most participants emit `SemanticEvent`s through `env.deliverSemanticEvent`, and forwarders emit JSON lines through `tui-protocol.emit`; duplicating ad hoc mocks will make assertions inconsistent.
**Decision:** Create `packages/baro-orchestrator/test/participants/helpers.ts`. It must export `source(agentId: string): Participant`, `captureEnv()` returning an `AgenticEnvironment`-compatible object with an `events: SemanticEvent<unknown>[]` array, `joinWithCapture<T extends { join?: unknown; setEnvironment?: unknown }>(participant: T)` for participants that use either `join(env)` or `setEnvironment(env)`, `withTempDir(prefix: string, fn: (dir: string) => Promise<void> | void)`, and `captureStdout(fn: () => Promise<void> | void): Promise<string[]>` for TUI forwarder tests.
**Consequences:** Tests assert on captured semantic events with factory guards such as `StoryResult.is(event)` and `Coordination.is(event)`. Forwarder tests parse captured stdout lines as `BaroEvent` JSON rather than monkey-patching production modules.
