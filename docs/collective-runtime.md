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

## Progressive planning (experimental opt-in)

Progressive planning removes the complete-plan startup barrier for one narrow
path. Enable it explicitly for a fresh headless Collective run:

```bash
BARO_PROGRESSIVE_PLANNING=1 baro --headless --coordination collective --local-only \
  "Your goal"
```

The switch is ignored outside headless `collective` coordination. On that
path, version 1 rejects an opted-in resume or follow-up instead of silently
changing its semantics. Without the opt-in, resume/follow-up and interactive
runs, as well as every `legacy` run, retain the existing behavior of waiting
for the complete Planner PRD before execution starts. This is an experimental
local evaluation surface, not a production-readiness or benchmark claim.

The fresh-run host first persists an empty bootstrap PRD with a correlated,
open `runtimeGraph.planning` latch. It starts the Collective and Planner
concurrently, then relays the private lifecycle records `planning_open`,
`plan_fragment`, `plan_complete`, and `plan_failed` into an exact
`PlanningFeed` participant on the Mozaik environment. While continuing to
inspect the repository and plan the remaining work, a capable Planner may
publish an ordered, add-only fragment whose dependencies are already admitted
or included in that same fragment. No fragment may contain a provisional
forward reference.

The Planner does not schedule work by publishing. The Board accepts records
only from its bound feed authority with matching run/planning correlation and
an open planning latch. It validates the schema, continuous ordinal,
idempotency fingerprint, unique story identities, dependency closure and DAG,
then applies the addition through the same durable runtime-graph/CAS path used
for other Collective adaptations. Only an admitted graph update can make a
story schedulable. When all currently admitted work settles while planning is
still open, the Board waits for the next fragment instead of treating the run
as complete.

Published stories are immutable. The final PRD must repeat every admitted
story as an exact, same-order prefix; it may only append a final suffix. Both
the native Planner session and the Board reconcile that contract, and the
Board also requires the final metadata to match the bootstrap. Invalid final
output can use the Planner's bounded repair loop before closure. Once an early
prefix exists, exhausted repair, a conflicting final plan or a rejected final
tail cannot fall back to an unrelated plan. Any terminal `plan_failed` closes
the planning latch as failed. The runtime may let already in-flight admitted
stories settle, but it cannot report the run successfully verified. This is
the fail-closed boundary that makes early execution safe to evaluate.

Native OpenAI-compatible planning currently exposes the strict
`publish_plan_fragment` tool. That includes GLM when it is reached through the
native OpenAI-compatible route. Claude Code, Codex, OpenCode and Pi Planner
backends do not yet publish early fragments: under the progressive host
lifecycle they produce the complete PRD, which is admitted at
`plan_complete`. Their story-execution capabilities are separate from this
Planner limitation.

In this document, `legacy` means the explicit compatibility engine in which a
Conductor reacts to bus events and drives the already-complete DAG by levels.
It remains useful for rollback and old-run comparison; it does not mean that
its code or protocol is silently selected on a Collective failure. Progressive
planning is Collective-only because its open-plan latch, durable fragment
admission and scheduling authority live on the Board.

This design sits directly on Mozaik without assigning domain authority to the
bus. Mozaik provides the shared environment, typed event delivery and exact
participant identity. Baro supplies the planning contract, correlation,
admission policy, durable graph mutation and scheduling. The Planner is
therefore an autonomous event producer, but neither a central coordinator nor
a bypass around Board, Broker, Repository, Critic or Verifier authority.

The focused control-plane checks are provider-free:

```bash
cd packages/baro-orchestrator
npm run typecheck
node --import tsx --test \
  test/planning/progressive-plan.test.ts \
  test/planning/progressive-planner-protocol.test.ts \
  test/participants/progressive-planning-board.test.ts \
  test/progressive-orchestrate.test.ts \
  test/progressive-cli-smoke.test.ts \
  test/stdin-commands.test.ts \
  test/planner-openai.test.ts

cd ../..
cargo test -p baro-tui progressive
cargo test -p baro-tui planner_stream_bridge
```

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

1. Before planning, the TUI/headless front door persists a correlated transcript.
   Every front-door request uses an isolated, short-lived Mozaik
   environment: the Conversation participant emits
   `repository_context_requested`, and an exact source-bound RepoScout returns a
   frozen, size-bounded `RepositoryBriefV1`. RepoScout starts from a
   deterministic snapshot, then its separate model policy iteratively selects
   exactly one Baro-owned `read_file`, literal `grep`, or `glob` observation per
   step. The broker is shell-free, rejects observed symlinks, excludes known
   credential/key/local-cloud-state paths, and enforces cumulative wall-clock and
   model-visible observation-byte bounds plus per-invocation traversal, search, and
   glob-work bounds. Model decisions have exact correlation; invalid decisions
   receive bounded same-step repair, and an unrecoverable provider/validation
   failure performs a final stability rescan before returning the explicitly
   truncated deterministic fallback. The Scout and Conversation roles default
   to the same selected backend/model but have
   independent responder seams for future cost routing.
   Successful autonomous briefs use an evidence-snapshot identity composed from
   the exact bootstrap projection and ordered observation suffix visible in the
   finishing policy call, plus the omitted-observation count. Clipped bootstrap
   paths must be rediscovered, and omitted earlier observations force an
   explicitly truncated result. That identity proves which evidence was projected, not
   that a model-authored statement is semantically true. Fact paths require
   bootstrap/read/search provenance, and a cited line must be visibly covered by
   a successful read/search observation. This is capability isolation, not a
   proof that model-authored summaries or questions are immune to repository
   prompt injection; user-facing text remains untrusted model output.
   Their harness process is rooted in an empty temporary directory and receives
   repository contents only as untrusted tool observations. Claude, OpenCode and
   Pi use explicit no-tool profiles. Codex uses a strict least-privilege profile
   that denies its empty workspace, tool network and inherited shell environment
   while ignoring local config, rules and project documents. A strict
   schema-v1 Conversation response may clarify, answer, or propose exactly one
   GoalEnvelope; it cannot name workers, routes, leases, retries, or DAG
   operations. Chat turns also request context because they may identify a new
   implementation follow-up; a direct repository-free chat call cannot return
   `ready`. A
   repository-scoped active-session index restores an unfinished clarification
   after restart and closes an interrupted old request before accepting a retry.
   Each provider call requests a 5-minute deadline, configurable with
   `BARO_CONVERSATION_PROVIDER_TIMEOUT_SECS` (15–1800). The Rust host clamps the
   effective value so two sequential provider windows plus a 30-second cleanup
   margin fit inside the configured turn deadline; the direct Node entry point
   rejects incompatible timeout pairs. A failed Scout call
   preserves deterministic context so Conversation can still be attempted;
   Conversation itself still requires the selected provider.
   The outer front-door wall-clock fail-safe defaults to 30 minutes and is
   configurable with `BARO_CONVERSATION_TURN_TIMEOUT_SECS` (60–7200); its high
   step cap is only a last-resort safety bound, not a target exploration budget.
2. A proposed `ready` GoalEnvelope remains in the single pending response slot
   until it is accepted. Every provider route runs a pre-acceptance Architect
   validation. Claude, Codex and native OpenAI-compatible routes validate with
   repository read-only capabilities. The Architect may
   replace the candidate with correlated, repository-cited clarification; a
   ready decision document is reused by Planner without a second Architect call.
   Brokered pre-accept context is checkout-contained, symlink-free and capped at
   8 KiB; the candidate goal has the same 8 KiB process-boundary cap. A
   30-minute wall-clock fail-safe has no turn budget, emits progress heartbeats,
   and terminates the complete provider process tree if it expires.
   The Codex route retains the checkout as its read-only working root for
   exploration, but disables automatic project-document/`AGENTS.md` prompt
   injection with strict CLI config (`project_doc_max_bytes=0`); repository
   files are evidence rather than pre-acceptance instructions.
   OpenCode and Pi lack a repository read-only CLI profile, so their
   pre-acceptance Architect is an inference-only evaluator in an empty directory
   with only the bounded brokered context. Quick mode retains the existing
   Architect skip. The broker rejects observed symlinks; use a disposable,
   remote-free immutable clone when hard isolation against concurrent checkout
   mutation is required.
3. During collective execution, a run-local `DialogueAgent` observes a bounded
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
  test/session/repository-brief.test.ts \
  test/session/repository-scanner.test.ts \
  test/session/autonomous-repository-scout.test.ts \
  test/session/conversation-frontdoor.test.ts \
  test/run-conversation-script.test.ts \
  test/architect-outcome.test.ts \
  test/run-architect-outcome.test.ts \
  test/architect-openai.test.ts \
  test/codex-one-shot.test.ts \
  test/exec-file-cli.test.ts \
  test/process-tree.test.ts
npm test

cd ../..
cargo test -p baro-tui
```

The paid A/B benchmark remains a separate final step. It should compare the
same frozen repository/task and hidden verifier across a plain strong-model
harness and Collective's cheaper model mix, with multiple repetitions and
provider cost evidence retained for every invocation. A Gateway-backed trial
is not cost-valid until its charge evidence is exported and correlated with the
runtime invocation ledger.
