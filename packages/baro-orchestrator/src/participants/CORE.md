# Core participants cheat sheet

All orchestration paths share one Mozaik `AgenticEnvironment`. Participants
observe typed semantic events and publish new events back to the same bus. The
canonical wire shapes live in [semantic-events.ts](../semantic-events.ts).
Detailed authority, retry, runtime-DAG, and cost-learning contracts are in
[collective-runtime.md](../../../../docs/collective-runtime.md).

## Legacy core

### Conductor

Source: [conductor.ts](./conductor.ts)

The legacy coordinator owns DAG levels, spawn slots, story retries/recovery
boundaries, PRD persistence, and run completion. It reacts to
`RunStartRequest`, self-ticks with `LevelComputeRequest`, launches
`StorySpawnRequest`s, consumes `StoryResult`s, applies buffered `Replan`s at a
level boundary, and eventually publishes `RunCompleted`. This remains the
default path unless collective coordination is selected.

## Shared execution edge

### StoryFactory

Source: [story-factory.ts](./story-factory.ts)

StoryFactory resolves each story's tier or explicit backend/model route and
launches the appropriate adapter in an isolated worktree. In legacy mode it
consumes direct spawn requests. In collective mode it advertises a
credential-free capability, bids on Board offers, accepts only a Broker lease,
binds the exact dynamic result/terminal authority, and rejects stale
run/lease/generation events. It also retains exact lease telemetry correlation
long enough to accept delayed authoritative measurements and update later
route estimates.

The executor seam in [story-executor.ts](./story-executor.ts) permits local,
test, or remote execution without changing the control plane. A collective
executor must synchronously register its result authority before it can emit a
terminal event.

### Backend story adapters

- [story-agent.ts](./story-agent.ts) drives a continuation-capable Claude CLI
  process. With review enabled, a failed exact-terminal Critique is written
  into the same process and a pass closes it.
- [openai-story-agent.ts](./openai-story-agent.ts) keeps a native Mozaik
  `ModelContext` across tool rounds and reviewed corrective turns. It also
  intercepts the closed-schema `propose_replan` tool inside the live loop.
- `codex-story-agent.ts`, `opencode-story-agent.ts`, and `pi-story-agent.ts`
  wrap one-shot external harness processes. They share terminal/failure
  semantics, but cannot continue inside an exited process after review.

Typed non-execution failures return to the collective operational recovery
lane instead of being treated as evidence that the model produced bad code.
`StoryResult` is only an execution outcome; acceptance and integration still
have independent authorities.

## Collective control plane

### CollectiveBoard

Source: [collective-board.ts](./collective-board.ts)

The Board is a deterministic projection and policy participant, not a model
supervisor. It offers ready work, validates exact correlated lifecycle events,
requests quality/integration/verification decisions, applies bounded recovery,
and declares completion only after the required independent authorities have
answered. Runtime graph changes pass through the durable coordinator before
the Board schedules newly ready work.

### LeaseBroker

Source: [lease-broker.ts](./lease-broker.ts)

The Broker owns offers, deterministic bid windows, claims, leases, expiry, and
release. Market bids contain only route descriptors and estimates; credentials
remain inside StoryFactory. The selected route can be suppressed after a
permanent provider failure, while operational recovery can reroute a later
offer.

### AcceptanceGate and Critic

Sources: [acceptance-gate.ts](./acceptance-gate.ts), [critic.ts](./critic.ts),
and backend-specific `critic-*` files.

Critic evaluates a terminal candidate only when repository and command
evidence are ready. AcceptanceGate correlates that verdict with the exact
lease, generation, and terminal identity before permitting integration.
Missing, stale, sandbox-blocked, or evaluator-unavailable evidence is
inconclusive and enters operational recovery; an evaluated rejection is a
semantic quality failure.

### Runtime replan and recovery

Sources: [runtime-replan-coordinator.ts](./runtime-replan-coordinator.ts),
[operational-recovery.ts](./operational-recovery.ts), and
[recovery-input.ts](./recovery-input.ts).

`RuntimeReplanCoordinator` validates graph-version CAS, exact lease authority,
idempotency, mutability, cycles, budgets, and persist-before-applied ordering.
Workers can propose changes through the native interception path or the
`agent-collab.mjs` bridge. Operational retries, worker/discovery adaptations,
and Surgeon semantic healing use separate accounting.

### Route learning

Sources: [route-learning.ts](./route-learning.ts) and
[model-telemetry-collector.ts](./model-telemetry-collector.ts).

Each configured market worker learns a run-local pseudo-prior estimate from
verified lease outcomes, latency, and known exact-correlated invocation cost.
Unknown cost remains unknown. The production Gateway/Cloud billed-cost
producer is not connected yet, so the current seam must not be described as
live billed-cost optimization.

## Human and advisory edge

### Operator

Source: [operator.ts](./operator.ts)

Operator translates external commands into bus-safe actions. `redirect`
publishes an `AgentTargetedMessage`; `converse` publishes
`ConversationRequested`; abort/shutdown commands invoke their bound hooks.
Operator does not own leases, graph mutation, integration, or completion.

### DialogueAgent

Sources: [dialogue-agent.ts](./dialogue-agent.ts) and
[dialogue-responder.ts](./dialogue-responder.ts), with the narrow proposal
contract in [conversation-delegation.ts](./conversation-delegation.ts).

DialogueAgent observes a bounded, selected, untrusted run projection and calls
a text-only responder only for an explicit conversation request. It may send a
bounded message to a live continuation-capable worker or publish one add-only
delegation proposal from its request-time graph snapshot. The proposal cannot
choose route/model/retry/priority or remove/rewire work. Board validates and
durably commits it with worker adaptation accounting, including a second exact
schema/correlation check at the Board boundary; Broker independently auctions
any resulting offer. Route capability and lease lifetime are source- and
correlation-bound before Dialogue may address a worker. Baro-created semantic
events are immutable snapshots before Mozaik fan-out. Dialogue cannot directly
bid, grant a lease, mutate durable state, integrate, verify, or complete a run.
It is still a text-only semantic supervisor rather than a full repository-tool
harness; the TUI redesign is deferred until the headless contract is stable.
