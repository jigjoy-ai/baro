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

### GoalGuardian

Source: [goal-guardian.ts](./goal-guardian.ts)

GoalGuardian is the independent semantic authority for the accepted
`GoalContract`. It projects exact story-to-invariant mappings, source-bound
challenges, durable integrations, and Critic quality tied to the exact lease.
In strict collective runs, locally passing story shards are necessary but not
sufficient: after final verification it requests one batched, read-only
GoalInvariantReviewer evaluation of every invariant against the complete
integration and verification basis. A pass is reusable only for that exact
basis fingerprint; changed quality, integration, remediation, protocol, or
verification evidence requires a new review. Every reconstructed Board uses a
fresh cryptographic verification epoch, so a persisted review from an older
coordinator instance cannot match the resumed completion basis. Failed or
inconclusive aggregate review currently fails the final goal closed rather
than reopening the graph or scheduling remediation. GoalGuardian may request
bounded corrective work and attest goal completion, but cannot schedule,
grant leases, mutate the graph, integrate code, or verify the run. Its
projection crosses the PRD persistence boundary before Board can accept a
completion attestation; restart replay cannot infer a green result from an old
or uncorrelated quality verdict.

### LeaseBroker

Source: [lease-broker.ts](./lease-broker.ts)

The Broker owns offers, deterministic bid windows, claims, leases, expiry, and
release. Market bids contain only route descriptors and estimates; credentials
remain inside StoryFactory. The selected route can be suppressed after a
permanent provider failure, while operational recovery can reroute a later
offer. If runtime adaptation targets work that is offered but not yet leased,
Broker serializes an exact retraction against bids, claims, and lease grants.
Only its `retracted` receipt permits the graph transaction; `leased` fences the
story from mutation.

### AcceptanceGate and Critic

Sources: [acceptance-gate.ts](./acceptance-gate.ts), [critic.ts](./critic.ts),
and backend-specific `critic-*` files.

Critic evaluates a terminal candidate only when repository and command
evidence are ready. AcceptanceGate correlates that verdict with the exact
lease, generation, and terminal identity before permitting integration.
Those verdicts remain intentionally story-local; the strict collective
GoalInvariantReviewer is the separate run-level composition check and does not
change legacy or non-strict Critic behavior.
Missing, stale, sandbox-blocked, or evaluator-unavailable evidence is
inconclusive. AcceptanceGate first asks AgentTurnProjector for a bounded replay
of the exact active lease/candidate, without another WorkOffer. Exhaustion
preserves the candidate and fails closed without an implementation recovery
wave; an evaluated rejection remains a semantic quality failure. This is
re-evaluation only: a trusted per-story CandidateVerifier that can create new
command evidence in the isolated worktree is still future work.

### Runtime replan and recovery

Sources: [runtime-replan-coordinator.ts](./runtime-replan-coordinator.ts),
[operational-recovery.ts](./operational-recovery.ts), and
[recovery-input.ts](./recovery-input.ts).

`RuntimeReplanCoordinator` validates graph-version CAS, exact lease authority,
idempotency, mutability, cycles, budgets, and persist-before-applied ordering.
Workers can propose changes through the native interception path or the
`agent-collab.mjs` bridge. Planned work can change immediately; offered work
first completes the Broker retraction handshake, while leased, integrating,
reviewing, recovery, and cleanup work remains immutable. Operational retries,
worker/discovery adaptations, and Surgeon semantic healing use separate
accounting.

### Route learning

Sources: [route-learning.ts](./route-learning.ts) and
[model-telemetry-collector.ts](./model-telemetry-collector.ts).

Each configured market worker learns a run-local pseudo-prior estimate from
verified lease outcomes, latency, and known exact-correlated invocation cost.
Unknown cost remains unknown. A concrete OpenAI route can receive authoritative
cost only from an explicitly configured, same-origin Baro Gateway receipt feed
whose credential and invocation correlation match that route. Harness-backed
workers and arbitrary compatible endpoints do not inherit billing authority;
their unknown cost remains unknown. Route learning is still run-local and
advisory, not a claim of globally calibrated live optimization.

### CollaborationBridge, Librarian, and Supervisor

Sources: [collaboration-bridge.ts](./collaboration-bridge.ts),
[librarian.ts](./librarian.ts), [memory-librarian.ts](./memory-librarian.ts),
and [supervisor.ts](./supervisor.ts).

In collective mode, worker messages are routed through the exact run-local
Bridge and rebound to the recipient's active run/lease/generation. Story
backends reject direct, stale, or same-label messages. Operator, the tag-based
Librarian, and Dialogue are the only in-process message-intent producers;
workers receive only an opaque loopback endpoint/token bound to their exact
lease, never the Bridge's manager-private session path. Claude and native
OpenAI use live delivery; Codex, OpenCode and Pi consume a broker inbox.
Pre-launch messages enter every backend's initial prompt exactly once, while a
poll response is printed before acknowledgement and may therefore repeat its
stable delivery id after a lost ACK. Ordinary worker events and durable
challenges use stable client ids, so an ambiguous HTTP outcome is retried with
the exact id and payload instead of creating a duplicate semantic action. A
request is correlation-checked again after its body is read, and release
revokes all message, note, help, discovery, and replan influence from that
lease. Durable challenges additionally require an invariant id from the
authoritative derived GoalContract, so a syntactically valid unknown id cannot
become an unacknowledgeable replay record.

Supervisor and both Librarians source-bind Broker lease transitions and the
dynamic worker authority registered for the exact attempt. Supervisor alone
may emit the correlated abort consumed by StoryFactory. Librarian findings may
become cross-worker context only after the call and output come from the same
active worker capability. These participants advise or intervene over Mozaik;
none owns scheduling, graph persistence, integration, or run completion.

## Human and advisory edge

### Conversation session and RepoScout

Sources: [conversation-frontdoor.ts](../session/conversation-frontdoor.ts) and
[autonomous-repository-scout.ts](../session/autonomous-repository-scout.ts).

Before a PRD exists, Conversation is the durable first-contact authority. For
each turn it asks an autonomous, read-only RepoScout to iteratively choose from
Baro-owned read/search/glob capabilities and return a source-bound evidence
brief. Conversation uses that brief to answer or clarify, then hands exactly
one accepted GoalEnvelope to Architect/Planner. RepoScout cannot write, run
commands, use the network, plan stories, select routes, or enter the execution
control plane; deterministic scanning is its bounded bootstrap and fail-safe.

### Operator

Source: [operator.ts](./operator.ts)

Operator translates external commands into bus-safe actions. `redirect`
publishes an `AgentTargetedMessage`; `converse` publishes
`ConversationRequested`. Direct abort/shutdown callback hooks are a legacy-only
adapter and orchestration rejects them in collective mode; collective control
must cross a source-bound Mozaik semantic lane. Operator does not own leases,
graph mutation, integration, or completion.

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
correlation-bound before Dialogue may address a worker. Board, Broker,
Repository, Critic, AcceptanceGate, Verifier, Bridge, and worker observations
are source-bound before they enter its prompt. Baro-created semantic
events are immutable snapshots before Mozaik fan-out. Dialogue cannot directly
bid, grant a lease, mutate durable state, integrate, verify, or complete a run.
An optional ephemeral `ConversationContextSnapshot` can seed the accepted goal,
summary, and bounded front-door history. The CLI accepts it only through
`--conversation-context-file` (or `BARO_CONVERSATION_CONTEXT_FILE`), validates
an exact size-bounded schema, and binds its session and goal fingerprint to the
PRD before the run starts. Free-form context stays in an explicitly untrusted
prompt section; only safe session correlation and the caller-owned lifecycle
phase reach the system layer. The snapshot is not copied into the PRD.
The in-run Dialogue participant is deliberately text-only rather than a second
repository harness: repository investigation belongs to the pre-run RepoScout
and later Architect, while execution remains with independently leased workers.
The TUI redesign is deferred until the headless contract is stable.
