# CORE Participants Cheat Sheet

The four driver participants that turn a PRD into a sequence of Claude
runs. Each one subscribes to bus events via `onExternalEvent` (or
`onInternalEvent` for self-tick), checks the discriminator with the
matching `.is()` type guard from [../semantic-events.ts](../semantic-events.ts),
and emits its own typed events back via `env.deliverSemanticEvent`. The
[../semantic-events.ts](../semantic-events.ts) module is the canonical
home of every event type's wire shape and factory.

## Conductor

Source: [conductor.ts](./conductor.ts)

Pure event-driven state machine that walks the story DAG. On a
`RunStartRequest` it loads the PRD; from there it self-drives
level-by-level by emitting `LevelComputeRequest` ticks. Each tick
consults `buildDag`, picks the first remaining level, fills the spawn
queue, and emits one `StorySpawnRequest` per story up to the configured
parallel cap. As `StoryResult` events arrive it records pass or fail,
marks passing stories in the PRD, and refills the spawn slot. When
every story in the level has settled it applies any `Replan` payloads
buffered during the level, persists the PRD, then self-ticks for the
next level. When `buildDag` returns no levels — or when a whole level
fails terminally with no replan — it emits `RunCompleted` and resolves
its `done` promise.

- Subscribes to:
  - `RunStartRequest` — begins the run.
  - `LevelComputeRequest` — self-tick: compute and launch the next level.
  - `StoryResult` — settle a story in the current level.
  - `Replan` — buffered until the level boundary, then applied to the PRD.
- Emits:
  - `RunStarted`, `LevelComputeRequest`, `LevelStarted`,
    `StorySpawnRequest`, `LevelCompleted`, `RunCompleted`.
  - `ConductorState` for phase transitions and hook-failure messages.

## StoryFactory

Source: [story-factory.ts](./story-factory.ts)

Decouples Conductor from `StoryAgent` lifecycle. On a `StorySpawnRequest`
it constructs a fresh `StoryAgent` with the requested prompt, model,
retries, and timeout, joins it to the environment, fires its `run()`
without awaiting, and emits a `StorySpawned` event so observers can
see the lifecycle. When the matching `StoryResult` later arrives on
the bus it calls the agent's `leave(env)` and drops its reference.
Spawn is idempotent per `storyId`.

- Subscribes to:
  - `StorySpawnRequest` — spawn the requested agent.
  - `StoryResult` — remove the finished agent from the bus.
- Emits:
  - `StorySpawned`.

## StoryAgent

Source: [story-agent.ts](./story-agent.ts)

Wraps a single Claude CLI invocation for one story with retries, a
per-attempt timeout, a quiet-timer for multi-turn sessions, and an
optional hard cap. Each attempt spawns a fresh `ClaudeCliParticipant`,
writes the prompt to stdin (leaving stdin open), then watches the bus
for `AgentResult` events addressed to this story so it can count turns
and reset the quiet timer. Stdin is closed when either `maxTurns`
`AgentResult` events have arrived or `quietTimeoutMs` of silence has
elapsed. On success the retry loop exits early; otherwise it retries
up to `retries + 1` attempts before giving up. Phase changes are
broadcast as `AgentState` events; the final verdict is broadcast as a
`StoryResult`. Note: `AgentTargetedMessage` → Claude stdin forwarding
is owned by `ClaudeCliParticipant`, not by `StoryAgent`; `StoryAgent`
only observes those items for quiet-timer purposes.

- Subscribes to:
  - `AgentTargetedMessage` (when `data.recipientId` matches this story)
    — resets the multi-turn quiet timer.
  - `AgentResult` (when `data.agentId` matches this story) —
    increments the turn counter and resets the quiet timer.
- Emits:
  - `AgentState` on every phase transition.
  - `StoryResult` — final outcome of the story, success or failure.

## Operator

Source: [operator.ts](./operator.ts)

Bridge from external command sources (the Rust TUI today, a web UI
later) onto the bus. Operator is push-only: it never reacts to bus
events (its `onExternalEvent` inherits BaseObserver's no-op default).
Callers invoke `dispatch(cmd)` when a command arrives over the TUI
protocol, and Operator translates it. A `redirect` command becomes an
`AgentTargetedMessage` on the bus addressed to the named story; the
`abort`, `abort_all`, and `shutdown` commands invoke the corresponding
hook callbacks supplied at construction (no bus event is emitted for
those three).

- Subscribes to: nothing — `onExternalEvent` is intentionally a no-op.
- Emits:
  - `AgentTargetedMessage` (only in response to a `redirect` dispatch;
    `abort` / `abort_all` / `shutdown` go to hooks instead of the bus).
