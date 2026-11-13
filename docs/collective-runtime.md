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
model and does not send corrective prose to the worker. Critic Git evidence,
Architect/Planner Bash tools, and final verification all use bounded,
process-group-aware launchers that drain the complete command tree before the
owning participant can settle.

AcceptanceGate keeps that lease and isolated worktree intact and requests up
to two neutral terminal replays through `AgentTurnProjector`. Each replay gives
Critic the same candidate output and a fresh repository snapshot; it does not
publish a `WorkOffer` or run another implementation agent. Continuation-capable
workers hand an inconclusive execution result to this gate instead of treating
it as a semantic pass. If the bounded rechecks remain inconclusive, Board
preserves the candidate and fails closed without a healing/implementation wave.

This protocol can recover from an evaluator outage and from readiness bugs when
usable fresh command evidence already exists. Baro does not yet have a trusted
per-story `CandidateVerifier` that executes new deterministic commands in the
active isolated worktree and contributes their output to Critic evidence.
Therefore genuinely missing or entirely stale command evidence remains
inconclusive after the bounded rechecks; a new coding worker is deliberately
not mislabeled as verification.

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

An `infrastructure` or `transport` attempt was never judged, so its retry
offer carries `resume: { preservedBranch, reverify: true }`. Before spawning
an agent, StoryFactory replays only the agent's own commits from the
preserved branch onto the latest run branch (the host's leftover-preservation
commit is excluded) and runs the story's gate on them. A green gate settles
the lease without an agent attempt: the gate commands become the attempt's
command evidence and a terminal turn describes the commit, so Critic and
integration judge it exactly as an agent's. A red or inconclusive gate, a
conflicting replay, or no agent commits falls back to a fresh worktree and
the ordinary recovery prompt.

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
- `GoalGuardian` independently projects the accepted `GoalContract`, exact
  story-to-invariant mappings, source-bound challenges, integration and
  lease-correlated Critic evidence. It proposes remediation work and attests
  completion, but cannot schedule or mutate the graph. Board may persist that
  projection but cannot manufacture its semantic contents;
- the Board projects durable run state, schedules newly-ready work, and remains
  the deterministic graph-transaction arbiter;
- the Broker auctions work among credential-free route advertisements;
  each worker id is bound by topology to one concrete StoryFactory before its
  capability advertisement or claim is accepted, so a bus participant cannot
  win a lease by inventing or impersonating a worker id;
- Critic owns acceptance evaluation, Repository owns integration, and the
  run verifier owns the final objective check;
- Dialogue may address a currently leased continuation-capable worker and may
  publish one bounded add-only delegation proposal from the graph version it
  actually observed. The exact Board validates and persists it through the
  same runtime coordinator; Dialogue cannot apply it, offer work, grant a
  lease, select a route, merge code, verify, or complete the run.

Collective worker messages are capabilities, not recipient labels. Operator,
the tag-based Librarian, and Dialogue may submit uncorrelated message intents;
the exact run-local `CollaborationBridge` is the only participant that may bind
one to the recipient's current run/lease/generation. Every story backend then
accepts the delivery only from that exact Bridge and correlation. Critic's
legacy compatibility message is deliberately outside this producer set, as
its authoritative path is `Critique`. A worker receives only a loopback
endpoint and opaque token for its exact lease; the Bridge's manager-private
session path is never rendered into a prompt or executor request. Any retained
compatibility/test mailbox names use reversible base64url encoding, so
distinct story ids cannot alias manager-owned state.

The same rule applies to observations that can transitively affect work.
Supervisor and both Librarian implementations learn active attempts only from
the exact Broker and accept tool/agent evidence only from the dynamic result
authority registered for that lease. Dialogue source-binds Board, Broker,
Repository, Critic, AcceptanceGate, Verifier, Bridge, and worker observations
before putting them into its prompt. Its output therefore does not turn an
ambient same-label bus event into a trusted worker message or graph proposal.

Native workers expose `propose_replan` inside their live inference loop. CLI
workers use `agent-collab.mjs` with that lease's endpoint/token and wait for
the same correlated bus decision. Claude and native OpenAI use live targeted
delivery; one-shot Codex, OpenCode and Pi consume a broker inbox. Messages
queued before any worker acquires its capability enter its initial prompt
exactly once. Poll output is written before acknowledgement, so a lost ACK may
repeat the same stable delivery id instead of silently losing the message. The
mechanism is therefore backend-specific at the edge and one semantic protocol
in the runtime. A discovered story carries the originating
lease and generation: the bridge publishes it only while that lease is active,
and the Board checks the correlation again. The HTTP ingress re-authenticates
the capability after reading each bounded request body, closing a release race;
release then revokes its attribution. Messages, help, notes, discoveries, and
replans submitted after the release boundary are stale and cannot influence
Dialogue or another worker.

A running worker that needs a file it did not declare claims it
(`agent-collab.mjs emit --kind claim --paths-json '["src/x.ts"]'`) before it
writes. The Board decides at once, from the same ownership rule as the write
gate: a path no story that has not integrated declares or holds (unowned, or
released by an integrated owner) becomes the claimant's, every running lease
receives the revised surface (`gate_rule_announced` with a `surfaceRevision`,
so a claim orders within one graph version), and running peers are told who
owns it; a path such a story still holds stays with it, and the claimant
messages that owner or blocks on it. The decision is in the broker receipt and
in a `claim_answer` message, and the bus records it as `paths_claimed`. A claim
ends when its claimant integrates, exactly like a declared write.

A Claude story's Bash runs inside Claude Code's own OS sandbox (Seatbelt on
macOS, bubblewrap and socat on Linux), configured by Baro in the story's
`--settings`: writes only to the worktree, the exact git metadata a commit
needs (`objects`, the story's branch ref and log, its worktree git dir; never
the shared config) and Claude's temp; reads everywhere except credential
stores (`~/.ssh`, `~/.aws`, gh, git and package-manager credentials); network
only to package registries and the lease's loopback broker
(`BARO_SANDBOX_ALLOWED_DOMAINS` adds hosts). `allowUnsandboxedCommands` is off
and `failIfUnavailable` is on, so a story whose sandbox cannot start does not
run; `permissions.blockWritesOutsideWorkingDirectories` holds Write and Edit to
the worktree. This is what holds a script the agent writes and runs, which the
command-level hook cannot see. `BARO_UNSAFE_NO_SANDBOX=1` turns it off.
Verified against Claude Code 2.1.318: a commit succeeds; a script writing the
shared `.git/config` or a sibling story's worktree gets `Operation not
permitted`; `~/.ssh` is unreadable; github.com is unreachable; the broker is.

Under that sandbox the story hook no longer judges each shell command: the
kernel already holds every process the command starts, and the command judge
refused harmless reads, heredocs, inline code and peer messages whose text held
a slash (test run 4). The hook still refuses publishing and shared git state
(`publish-guard.ts`), and Write/Edit stay inside the worktree. With
`BARO_UNSAFE_NO_SANDBOX=1` the command judge is the only guard and runs as
before; the hook's self-check probes it either way. Verified against the live
CLI: inline python and a commit inside the worktree work; a write to the main
checkout or another repo, from the shell or from python, fails with `Operation
not permitted`; `git push` is refused by the hook.

Package managers write to a Baro-owned cache (`~/.baro/cache/packages`,
`BARO_PACKAGE_CACHE` overrides it), set through `npm_config_cache`,
`PIP_CACHE_DIR`, `XDG_CACHE_HOME`, `CARGO_HOME` and their peers; the user's own
caches stay unwritable, so a story cannot poison the user's next install. The
Codex, OpenCode, Pi and Devin lanes use the same cache. The Claude sandbox sets
`enableWeakerNetworkIsolation`, which lets clients that verify TLS through
macOS `trustd` (pip, Go, gh) do so; without it pip fails with `OSStatus
-26276`. The domain allowlist still applies.

Read-only Claude roles (architect, scouts, planner, surgeon) run under
`dontAsk`, which refuses every read outside the checkout. They approve
Read/Glob/Grep explicitly and deny the same credential stores, so a goal can
point at a symlinked SDK or a sibling checkout.

A dependency is a merge order, not a start barrier. A running story whose
dependents need only part of its work (an interface, fixtures, a schema)
commits that part and publishes it (`--kind checkpoint --reason "..."`). The
Board accepts it from the live lease when the commits stay inside the story's
surface, and admits every dependent whose prerequisites are each integrated or
checkpointed. Such a dependent's worktree merges the checkpoint commits onto
the run branch, and that merge is its recorded base, so its own diff and
fingerprint stay its own. It integrates only after each prerequisite it
started on has: an accepted early starter waits (`S2 is accepted and
integrates after S1`), and since the prerequisite's final branch contains the
same commits, the later merge is a clean continuation. If the prerequisite
fails or loses its lease, the checkpoint is withdrawn: finished early starters
retry from the run branch, running ones are told and can block on it, and a
story whose early start failed once waits for integration next time. A
dependent that finds it needs the finished work blocks on the prerequisite
(`--kind block`) as before.

Durably handed-off goal challenges remain replayable until their persisted
Guardian projection acknowledges them. Before persistence, the Bridge also
checks the challenge invariant against the exact derived GoalContract allowlist;
unknown G-A/G-C ids are rejected instead of becoming immortal replay records.

The runtime is distributed, but it is not leaderless. Board serializes
scheduling and durable graph commits; it does not call a model, decide goal
meaning, select a route, grant its own lease, evaluate quality, merge code, or
verify the run. Those authorities remain separate participants. This boundary
is intentional: Baro decentralizes semantic and operational authority while
retaining one deterministic transaction order for a shared repository.

A runtime mutation may change a planned sibling immediately. If the target is
already offered but not leased, Board first sends an exact, correlated offer
retraction request. Broker serializes it against bids, claims and lease grants,
tombstones a successfully retracted offer, and returns an ACK. Only that ACK
allows Board to commit the graph mutation. A `leased` response makes the story
immutable; a missing or conflicting ACK rejects the proposal fail-closed.
Leased, integrating, quality/recovery and cleanup work always remains
immutable. Thus adaptation does not race a worker that may already be writing.

Any source-bound participant may raise a goal-invariant challenge through the
lease-validating bridge. Guardian turns an unresolved challenge into bounded,
goal-mapped corrective work; Board admits it through the same durable graph CAS
lane. Completion requires the Guardian projection to cross the PRD persistence
boundary before its attestation is accepted. In strict quality mode, a Critic
verdict must match the exact integrated lease. A PRD-only restored integration
without that correlation is revalidated rather than inferred green.

The soft run deadline is an actual timer, not only a scheduler poll. It ends a
run waiting on an empty open planning stream, prevents dispatch of another
wave after expiry, and fails directly if repository preparation never
completed; already leased work is still allowed to settle through its normal
fenced lifecycle. Final
goal attestation has its own exact check/contract/verification correlation and
a 30-second fail-closed default (`BARO_GOAL_COMPLETION_TIMEOUT_SECS`), so a
silent or stale Guardian response cannot leave finalization open forever.

Collective completion is strict about objective evidence: only a coherent
`passed` verifier result can proceed to GoalGuardian. A `skipped` result means
the objective gate is unknown/incomplete—even when no applicable command was
discovered—so the run retains its integrated work as an unsuccessful
checkpoint rather than reporting green. A passing payload that contains a
failed/skipped command, or no passing command at all, is normalized
fail-closed at the Board boundary.

At each verification request, RunVerifier rereads the final PRD and combines
its current `userStories[].tests` with the frozen pre-run automatic gates.
Runtime-added tests therefore enter the gate and runtime-removed tests leave
it, while baseline package-manager authority and executable gates remain
frozen. PRD command strings never enter a shell: the translator admits only
conventional npm/pnpm/Yarn `build`, `typecheck`, `test`, or `lint` scripts;
narrow Cargo build/check/test/clippy/fmt checks; contained `node --check` or
`node --test` paths; exact `npx rstest run` paths; exact `git diff --check`;
conventional Composer `build`, `typecheck`, `test`, `lint`, or `check` scripts
anchored to a root `composer.json`; a contained `vendor/bin/phpunit` limited to
`--testsuite <name>`, `-c`/`--configuration <file>`, and contained test paths;
and `ddev exec <command>` as a transparent prefix that requires `.ddev/config.yaml`
and re-applies the same policy to the wrapped command. Composer trust is a
separate baseline set from the npm one, and `ddev exec` grants no authority: a
wrapped command the translator would reject directly stays rejected with the same
reason. Custom package scripts,
missing scripts/tools, unsupported flags, quoting, response files, and lexical
or symlink path escapes become explicit incomplete evidence. Eight unique PRD
commands and eight final-plan executable additions are the bounded defaults;
raw schema inspection is additionally capped at 256 stories/64 requirements.
Any overflow becomes incomplete evidence, and the Board watchdog reserves a
full per-command timeout plus process-tree settlement grace for every admitted
slot. Conventional script names are the current trust policy; their bodies are
not yet pinned to a baseline hash, so extending the allowlist to arbitrary
custom script names requires an additional authority design rather than a
string-parser exception.

Git/worktree and final publishing commands also have a production-safe
10-minute per-command ceiling, configurable with
`BARO_REPOSITORY_COMMAND_TIMEOUT_SECS`. Reaching it terminates and drains the
complete process tree before `GitGate` is released. A timed-out repository
mutation is classified as infrastructure `command_timeout`; it is not allowed
to fall back to the shared tree or masquerade as a provider timeout, and an
affected isolated branch/worktree is retained whenever its state cannot be
proven safe.

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

## Architect fast path

In `--mode auto` the intake sizes an accepted goal before the Architect runs.
When the model (not the heuristic fallback) answers `focused` with
`maxStories: 1` and confidence of at least 0.85, the goal goes to the Planner
without an Architect pass, keeping the conversation's repository brief; that
story owns every goal invariant, and Critic and Surgeon still review it. The
stream carries `architect_skipped` with the intake's reason. Any other
contract, a fixed `--mode`, `--confirm-mode`, or
`BARO_ARCHITECT_FAST_PATH=0` keeps the Architect. The same path takes a
confident `sequential` goal of at most six steps and a confident `parallel`
goal of at most four parts: both run as one story, which may hand parts to
forks of its session (see Session inheritance). In `bench/`, a one-route
goal went from 231 s and $0.64 to 146 s and $0.18.

## Session inheritance

A story does not have to start cold. When the Board offers a story it names
whose session the agent starts from (`sessionSource` on the spawn request):

- a story resumed after suspending on its prerequisites continues its own
  session (`continue`);
- otherwise it forks the story it builds on: the checkpoint it starts from,
  the agent that proposed it, or its only prerequisite (`fork`).

The factory resolves that against the run's session ledger. The Claude lane
starts the process with `--resume <id>` (plus `--fork-session` for a fork); the
native lane starts from the parent's context items. Other lanes, a parent on a
different lane, a session over `BARO_SESSION_FORK_MAX_TOKENS` (default
120000), or a session that cannot be resumed start cold, and the story log
says why (`[session] ...`). Only the first attempt inherits; a resume that
fails is rerun cold without using a retry. `BARO_SESSION_FORK=0` turns
inheritance off.

A run with a single story (`--quick`, or the Architect fast path) tells that
story it may split the goal: one replan adds a story per independent part and
makes them its prerequisites, the parts run in parallel as forks of its
session, and it is resumed in that session to connect and verify them. At most
three stories can be added this way (`maxDynamicStories`). `BARO_LEAD_SPLIT=0`
removes the instruction.

## Progressive planning (experimental opt-in)

Progressive planning removes the complete-plan startup barrier for one narrow
path. Enable it explicitly for a fresh headless Collective run:

```bash
BARO_PROGRESSIVE_PLANNING=1 baro --headless --local-only \
  "Your goal"
```

The switch is ignored outside headless runs. On that path, version 1 rejects
an opted-in resume or follow-up instead of silently changing its semantics.
Without the opt-in, resume/follow-up and interactive runs retain the existing
behavior of waiting for the complete Planner PRD before execution starts. This is an experimental
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

Native OpenAI-compatible planning exposes the strict `publish_plan_fragment`
tool. That includes GLM when it is reached through the native OpenAI-compatible
route. Claude Code and Codex expose the same run-scoped capability through an
isolated stdio MCP server whose calls are validated and relayed by the parent
Planner process. OpenCode and Pi Planner backends remain final-only: under the
progressive host lifecycle they produce the complete PRD, which is admitted at
`plan_complete`. Their story-execution capabilities are separate from this
Planner limitation.

Progressive planning's open-plan latch, durable fragment admission and
scheduling authority live on the Board.

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
npm test

cd ../..
cargo test -p baro-tui progressive
cargo test -p baro-tui planner_stream_bridge
```

See [testing.md](testing.md) for the fast and slow lanes.

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
lease ledger remains available through final billing reconciliation, so a late
authoritative receipt updates the correct old lease rather than a newer retry.

Billing authority is explicit and route-bound. `BARO_GATEWAY_BILLING_URL`
opts in one trusted Gateway origin; the matching API key authenticates the
cursor feed, while locally allocated opaque invocation identities bind each
receipt to Baro-owned run/phase/story correlation. The backend performs the
actual billing and returns canonical receipts; Baro validates and deduplicates
them, publishes the resulting measurement, and only then advances the feed
cursor. Generic OpenAI-compatible endpoints, Claude Code, Codex, OpenCode and
Pi never become billing authorities implicitly. Missing or late receipts stay
unknown instead of becoming zero-cost observations.

Final reconciliation waits (bounded, 5 s by default) for outstanding receipts
only when the feed response carries `x-baro-billing-receipts: authoritative`,
which a Gateway sends once it finalizes receipts. Without that header Baro
still ingests whatever one final feed pass returns, then stops waiting and does
not report the unreceipted invocations as a reconciliation failure.

Selection is currently deterministic and greedy after policy constraints;
there is no uncertainty-driven route exploration yet, so configured priors
still matter. Learning is advisory and run-local; durable, cross-run
calibration belongs to repeated externally verified trials. Consequently this
wiring makes cost evidence lossless, but does not by itself prove that
Collective is cheaper or better than a single-agent harness.

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
the orchestrator exits.

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
