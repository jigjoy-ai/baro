# Collective runtime architecture

Baro Collective combines continuation-capable review loops on supported
backends with coordination that remains distributed over the Mozaik event
bus. A conversational participant may explain state, relay suggestions, and
propose a bounded add-only work package, but it is not a hidden second control
plane and cannot schedule or declare work complete by itself.

## Execution guarantees

An agent's candidate completion is not by itself an accepted result. When
acceptance review is required, Claude and native OpenAI workers wait for a
`Critique` from the exact bound Critic and exact `terminalId`:

1. a passing review closes the story execution;
2. a failing review is sent back into the same live model context;
3. the revised terminal turn receives a new, independently correlated review;
4. a missing or unavailable review is an operational incident, not evidence
   that the candidate code is bad.

Native OpenAI-compatible workers keep the same Mozaik `ModelContext`. Claude
workers keep the same CLI process and stdin session. Their review mailbox is
terminal-keyed and race-safe: it accepts a correlated verdict delivered before
or after the wait is registered. Stale, replayed, cross-agent, and
wrong-authority verdicts cannot finish a story. Codex, OpenCode, and Pi workers
currently remain one-shot processes. For those backends, `AcceptanceGate`
blocks integration and a failed verdict requires another recovery execution;
it cannot revise inside the exited process.

Critic verdicts are evidence-gated. Repository evidence and observed command
evidence are captured immediately before evaluation. Missing repository
evidence, stale or unverifiable command evidence, an unfinished command, or a
sandbox-blocked check produces `inconclusive`; it does not invoke an evaluator
model and does not send corrective prose to the worker.

## Failure policy

`StoryResult.failure` is typed so infrastructure incidents cannot silently
become code-quality failures:

| Lane | Examples | Runtime policy | Quality learning |
|---|---|---|---|
| `execution` | model error, turn limit, evaluated quality rejection | same-session correction when possible, then bounded semantic recovery | negative observation |
| `provider_capacity` | permanent quota/session exhaustion | disable that route and reroute | no model-quality penalty |
| `transport` | timeout, reset, DNS, TLS, offline network | bounded reconnect/reroute | no model-quality penalty |
| `infrastructure` | tool/spawn/auth/worktree/review failure | bounded operational retry/reroute | no model-quality penalty |
| semantic `verification` | acceptance or canonical check did not pass | bounded semantic recovery | negative observation |
| operational `verification` | unavailable evaluator or missing/stale evidence | reacquire evidence/evaluator through operational recovery | no model-quality penalty |

Operational recovery has its own per-story budget and never invokes Surgeon.
Partial work is checkpointed before a retry when possible. A permanent route
failure suppresses that route; a transient rate limit or network failure does
not permanently poison it. Typed non-execution failures do not consume the
worker's story retry budget; the Board owns the next lease/reroute and honors
`retryAfterMs`. Native OpenAI additionally permits a small bounded reconnect
inside one inference round. Permanent capacity rerouting is bounded by the
finite set of eligible routes rather than by the operational retry counter.

## Distributed autonomy and runtime graph changes

Mozaik transports typed events and model/tool items. Baro participants own the
domain policies. Control-plane decisions—results, discovery, replans,
integration, and verification—require exact participant authority and their
applicable run/story/lease/generation correlation. Baro semantic-event
factories snapshot and deeply freeze their wire payload before Mozaik fans it
out, so an earlier subscriber cannot rewrite a later participant's mailbox:

- workers execute stories, exchange discoveries, and can propose graph
  changes while still running;
- `RuntimeReplanCoordinator` validates authorization, graph-version CAS,
  idempotency, cycles, mutability, and durability before publishing an applied
  decision;
- the Board projects durable run state and schedules newly-ready work;
- the Broker auctions work among credential-free route advertisements;
- Critic owns acceptance evaluation, Repository owns integration, and the
  run verifier owns the final objective check;
- Dialogue may address a currently leased continuation-capable worker and may
  publish one bounded add-only delegation proposal from the graph version it
  actually observed. The exact Board validates and persists it through the
  same runtime coordinator; Dialogue cannot apply it, offer work, grant a
  lease, select a route, merge code, verify, or complete the run.

Native workers expose `propose_replan` inside their live inference loop. CLI
workers use the `agent-collab.mjs` bridge and wait for the same correlated bus
decision. The mechanism is therefore backend-specific at the edge and one
semantic protocol in the runtime. A discovered story carries the originating
lease and generation: the bridge publishes it only while that lease is active,
and the Board checks the correlation again. A retained final note may still be
useful context after release, but it cannot mutate the DAG.

Three budgets are accounted independently:

- worker/discovery DAG adaptations: `BARO_RUNTIME_ADAPTATION_BUDGET` (default
  `6` between integrated stories);
- Surgeon/policy healing: `BARO_REPLAN_PROGRESS_BUDGET` (default `3` between
  integrated stories);
- operational retry/reroute: `maxOperationalRetriesPerStory` (default `2`).

An integrated story resets both no-progress adaptation counters. Operational
incidents do not consume either counter. Runtime mutation also has an overall
`maxDynamicStories` bound (default `3` worker-added stories per run). Separate
counters prevent accidental cross-charging; they do not by themselves
guarantee that one lane cannot consume wall-clock time.

## Cost/quality routing

Each market worker learns its own route estimate from exact lease-correlated
runner telemetry and authoritative lease outcomes in the current run. It
deduplicates measured invocation cost, records lease latency, counts only
`integrated` as verified success, and counts only semantic execution or
evaluated quality failure against success probability. Operational failures
still contribute observed latency/cost when known, but do not lower the
route's quality estimate.

The estimate uses configured values as fixed-weight pseudo-priors and publishes
`RouteEstimateUpdated` before later auctions use the historical estimate. A
lease ledger remains available until `RunCompleted`, so a later authoritative
measurement can update the correct old lease without being attached to a new
retry. This is a supported ingestion seam, not a claim that production billing
is already connected.

Known runner-reported equivalent cost can update an estimate today. Native
OpenAI provider/customer cost remains `pending_gateway_meter`: Baro Gateway and
Baro Cloud do not yet publish a correlated measurement into this collector.
Unknown cost is never converted to zero and cannot support a claim that
Collective is cheaper. Selection is currently deterministic and greedy after
policy constraints; there is no uncertainty-driven route exploration yet, so
configured priors still matter. Learning is advisory and run-local; durable,
cross-run calibration belongs to repeated externally verified trials.

## Conversation and TUI boundary

Baro has two deliberately separate conversation layers owned by one durable
logical session:

1. Before planning, the TUI/headless front door persists a correlated transcript
   and runs each provider turn in a fresh process rooted in an empty temporary
   directory. A strict schema-v1 response may clarify, answer, or hand exactly
   one validated `GoalEnvelope` to planning. It cannot inspect the repository or
   name workers, routes, leases, retries, or DAG operations.
2. During collective execution, a run-local `DialogueAgent` observes a bounded
   semantic projection on the same Mozaik bus. It answers an explicit operator
   message, can message a live continuation-capable worker, and can emit one
   atomic proposal containing at most two new implementation stories. The
   proposal ID is deterministic, its CAS version is snapshotted before the
   model call, and its schema has no remove/rewire/model/route/retry/priority
   fields. The Board accepts events only from the exact bound Dialogue object,
   revalidates the deterministic correlation and exact 1–2 story schema, maps
   it to worker-accounted runtime adaptation, and retains graph CAS,
   idempotency, dynamic-story and no-progress budgets. Dialogue also accepts
   route capability only from a correlated Broker grant or an exact
   worker-ID-mapped StoryFactory, never lets a factory override the Broker's
   route, and ignores stale lease releases. Broker still owns the auction and
   lease, so an accepted proposal does not directly spawn a process.

For local Claude Code and Codex runs, Rust projects only the accepted goal,
accepted-goal phase, optional summary, and at most 24 complete correlated
history records into an exact schema-v1 file capped at 128 KiB. The file is
private and temporary, is bound again to the PRD session ID and `GoalEnvelope`
before use, is not inherited by worker subprocesses, and is deleted as soon as
the orchestrator exits. `legacy` coordination still uses the conversation-first
front door and durable goal metadata, but intentionally omits this run-local
Dialogue projection because legacy has no Dialogue participant.

This intentionally does not turn Dialogue into a central root coordinator. The
provider process remains text-only and disposable; durable history and a bounded
context snapshot provide semantic continuity, while Board, Broker, Repository,
Critic and Verifier retain their independent authorities. That separation is
the Mozaik-specific value: a familiar conversational surface without collapsing
the runtime back into one harness process.

## Provider-free verification

These checks exercise the control plane with fake backends and local fixture
processes. They do not call paid providers:

```bash
cd packages/baro-orchestrator
npm run typecheck
node --import tsx --test \
  test/provider-failure.test.ts \
  test/participants/openai-story-agent.test.ts \
  test/participants/story-agent.test.ts \
  test/participants/critic-evidence.test.ts \
  test/participants/acceptance-gate.test.ts \
  test/participants/collaboration-bridge.test.ts \
  test/participants/dialogue-agent.test.ts \
  test/participants/conversation-delegation-board.test.ts \
  test/participants/collective-authority.test.ts \
  test/participants/lease-broker.test.ts \
  test/participants/model-telemetry-collector.test.ts \
  test/participants/operational-recovery.test.ts \
  test/participants/collective-board.test.ts \
  test/participants/runtime-replan-coordinator.test.ts \
  test/participants/story-factory.test.ts \
  test/collective-orchestrate.test.ts \
  test/runtime/story-outcome-authority.test.ts
npm test
```

The paid A/B benchmark remains a separate final step. It should compare the
same frozen repository/task and hidden verifier across a plain strong-model
harness and Collective's cheaper model mix, with multiple repetitions and
provider cost evidence retained for every invocation. A Gateway-backed trial
is not cost-valid until its charge evidence is exported and correlated with the
runtime invocation ledger.
