# CORE Participants Cheat Sheet

The four driver participants that turn a PRD into a sequence of Claude
runs. Each one subscribes to bus events via `onContextItem` and emits
its own `ContextItem`s back. Wire shapes for canonical events live in
[../types.ts](../types.ts); a few items are defined alongside their
emitter and are marked below.

## Conductor

Source: [conductor.ts](./conductor.ts)

Pure event-driven state machine that walks the story DAG. On a
`RunStartRequestItem` it loads the PRD; from there it self-drives
level-by-level by emitting `LevelComputeRequestItem` ticks. Each tick
consults `buildDag`, picks the first remaining level, fills the spawn
queue, and emits one `StorySpawnRequestItem` per story up to the
configured parallel cap. As `StoryResultItem`s arrive it records pass
or fail, marks passing stories in the PRD, and refills the spawn slot.
When every story in the level has settled it applies any `ReplanItem`s
buffered during the level, persists the PRD, then self-ticks for the
next level. When `buildDag` returns no levels — or when a whole level
fails terminally with no replan — it emits `RunCompletedItem` and
resolves its `done` promise.

- Subscribes to:
  - `RunStartRequestItem` — begins the run.
  - `LevelComputeRequestItem` — self-tick: compute and launch the next level.
  - `StoryResultItem` (defined in `story-agent.ts`) — settle a story in the current level.
  - `ReplanItem` — buffered until the level boundary, then applied to the PRD.
- Emits:
  - `RunStartedItem`, `LevelComputeRequestItem`, `LevelStartedItem`,
    `StorySpawnRequestItem`, `LevelCompletedItem`, `RunCompletedItem`.
  - `ConductorStateItem` (defined in `conductor.ts`) for phase
    transitions and hook-failure messages.

## StoryFactory

Source: [story-factory.ts](./story-factory.ts)

Decouples Conductor from `StoryAgent` lifecycle. On a
`StorySpawnRequestItem` it constructs a fresh `StoryAgent` with the
requested prompt, model, retries, and timeout, joins it to the
environment, fires its `run()` without awaiting, and emits a
`StorySpawnedItem` so observers can see the lifecycle. When the
matching `StoryResultItem` later arrives on the bus it calls the
agent's `leave(env)` and drops its reference. Spawn is idempotent per
`storyId`.

- Subscribes to:
  - `StorySpawnRequestItem` — spawn the requested agent.
  - `StoryResultItem` (defined in `story-agent.ts`) — remove the
    finished agent from the bus.
- Emits:
  - `StorySpawnedItem`.

## StoryAgent

Source: [story-agent.ts](./story-agent.ts)

Wraps a single Claude CLI invocation for one story with retries, a
per-attempt timeout, a quiet-timer for multi-turn sessions, and an
optional hard cap. Each attempt spawns a fresh `ClaudeCliParticipant`,
writes the prompt to stdin (leaving stdin open), then watches the bus
for `ClaudeResultItem`s addressed to this story so it can count turns
and reset the quiet timer. Stdin is closed when either `maxTurns`
`ClaudeResultItem`s have arrived or `quietTimeoutMs` of silence has
elapsed. On success the retry loop exits early; otherwise it retries
up to `retries + 1` attempts before giving up. Phase changes are
broadcast as `AgentStateItem`s; the final verdict is broadcast as a
`StoryResultItem`. Note: `AgentTargetedMessageItem` → Claude stdin
forwarding is owned by `ClaudeCliParticipant`, not by `StoryAgent`;
`StoryAgent` only observes those items for quiet-timer purposes.

- Subscribes to:
  - `AgentTargetedMessageItem` (when `recipientId` matches this story)
    — resets the multi-turn quiet timer.
  - `ClaudeResultItem` (when `agentId` matches this story) —
    increments the turn counter and resets the quiet timer.
- Emits:
  - `AgentStateItem` on every phase transition.
  - `StoryResultItem` (defined in `story-agent.ts`) — final outcome of
    the story, success or failure.

## Operator

Source: [operator.ts](./operator.ts)

Bridge from external command sources (the Rust TUI today, a web UI
later) onto the bus. Operator is push-only: its `onContextItem` is a
no-op and it never reacts to bus events. Callers invoke
`dispatch(cmd)` when a command arrives over the TUI protocol, and
Operator translates it. A `redirect` command becomes an
`AgentTargetedMessageItem` on the bus addressed to the named story; the
`abort`, `abort_all`, and `shutdown` commands invoke the corresponding
hook callbacks supplied at construction (no bus event is emitted for
those three).

- Subscribes to: nothing — `onContextItem` is intentionally empty.
- Emits:
  - `AgentTargetedMessageItem` (only in response to a `redirect`
    dispatch; `abort` / `abort_all` / `shutdown` go to hooks instead of
    the bus).
