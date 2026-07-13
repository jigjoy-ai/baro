# Comparing legacy and collective coordination locally

This experiment answers one narrow question: with the same repository state, plan, models, and limits, does collective coordination produce a better result than the legacy Conductor?

`legacy` is the existing production path: one Conductor owns DAG levels, retries and completion, while StoryFactory and the observer agents communicate over Mozaik. It remains the default when no flag or environment variable is set.

`collective` is the opt-in path. A deterministic board projects run state, workers publish credential-free capabilities and bids, a broker grants a correlated lease to one deterministic winner, repository integration reacts to events, and workers can ask peers for help or discover additional work. With Critic enabled, a successful process result must also receive the correlated terminal-turn acceptance verdict before integration. A story passes only after that policy gate and `StoryMerged`, not merely after its model process exits successfully.

Both modes use the same Mozaik `AgenticEnvironment`, participant membership and `SemanticEvent` delivery. Collective mode does not introduce another bus. Baro owns the product-specific layer Mozaik should not own: event schemas, ordered participant mailboxes, work leases, DAG policy, git integration, recovery policy and the local worker-to-bus bridge.

Collective control decisions are source-bound as well as correlated. Knowing a
`leaseId` is not enough to report success or failure: the selected
`StoryFactory` registers the exact dynamic participant that may publish the
terminal `StoryResult` for that run/story/lease/generation. Repository,
verification, quality, recovery and conversation events are likewise accepted
only from their bound live participants. A custom `StoryExecutor` used in
collective mode must call the supplied `registerResultAuthority` callback
synchronously, before its first terminal event and before `start()` returns;
otherwise the spawn fails closed. Legacy executors remain compatible because
the callback is absent on the legacy path.

### Runtime DAG adaptation

Collective workers can now propose an atomic DAG mutation while their story is
still running. The proposal carries the exact run/story/lease/generation plus
the `graphVersion` visible at launch. The Board builds and validates a complete
candidate, then atomically replaces the PRD snapshot containing the graph,
version and applied-decision ledger (this is not an `fsync` power-loss
guarantee), and only then emits `runtime_replan_applied`. Invalid, stale,
cyclic, unauthorized, over-budget or
non-durable candidates receive a correlated `runtime_replan_rejected`; a
proposal is never displayed as applied merely because a model requested it.

Mozaik 3.12 does not export a separate `InferenceInterceptor` class. On the
native OpenAI-compatible story path, Baro intercepts the model's
`propose_replan` function item inside the in-process inference loop, before
ordinary tool execution, and returns the Board decision as the matching
function output. The tool has a closed JSON schema and Baro parses it
fail-closed locally. This is not a provider-side strictness guarantee: Mozaik
3.12 does not forward the tool's `strict` marker to the provider request.
Mozaik 3.12 also does not expose a provider `AbortSignal` from `infer()`: Baro
stops the local story loop and forbids overlapping retries after a timeout,
but the already-sent HTTP request may still settle and be billed once.
Claude Code, Codex, OpenCode and Pi are external CLI harnesses, so an
already-sent provider request cannot be rewritten. They use the same semantic
contract through `agent-collab.mjs`; the shell tool waits for the correlated
decision JSON instead of merely reporting that an outbox file was queued.

Proposal IDs are idempotency keys. Re-delivering the exact same proposal
returns its remembered decision without applying the mutation again. Reusing
an ID with different content is rejected. An applied decision's `graphVersion`
always remains the version at which it committed; on replay,
`currentGraphVersion` reports the latest version known by the Board. A worker
must use that latest value as the next proposal's `baseGraphVersion`. The
coordinator can restore applied decisions from the PRD's `runtimeGraph`
metadata when a host resumes the exact same `runId`. The current public CLI
does not yet expose process-level run resumption: a normal restart creates a
new run identity, retains the graph/version as its baseline, resets the
per-run discovery budget, and does not expose the old decision ledger.
Same-run replay is therefore a control-plane foundation, not yet an
end-to-end CLI restart feature.

New independent work can join the current live wave immediately. New dependent
work is durable immediately and becomes runnable as soon as its dependencies
integrate. Stories that are already context-pending, offered, leased, running,
quality-pending, integration-pending, failed/recovering or completed are
immutable to this runtime path. Replacing active work safely requires a future
authenticated revoke → process-stopped → preserve/cleanup handshake; the older
uncorrelated `StoryIntervention` event is deliberately not used as a shortcut.

The replan command exposed in each collective CLI worker's prompt is equivalent
to:

```bash
node packages/baro-orchestrator/scripts/agent-collab.mjs emit \
  --session /path/to/session/collective \
  --lease RUN_LEASE_ID \
  --kind replan \
  --base-version 1 \
  --replan-json '{"addedStories":[],"removedStoryIds":[],"modifiedDeps":{}}' \
  --reason 'why the future plan must change'
```

Use `currentGraphVersion` when present (otherwise the returned
`graphVersion`) for the next proposal. This command is
intended for a live leased worker; a released or superseded lease is rejected
locally and cannot mutate the Board.

If the command exits with code `3` and returns `outcome_unknown`, do not infer
that the proposal failed. Query the same idempotency key until its late
authoritative decision is available:

```bash
node packages/baro-orchestrator/scripts/agent-collab.mjs decision \
  --session /path/to/session/collective \
  --proposal THE_SAME_PROPOSAL_ID \
  --wait-ms 30000
```

It does not publish a package, create a pull request, contact Baro Cloud, or run either arm in the source repository. Each trial uses an independent local clone created with `--no-hardlinks`; every git remote is removed before Baro starts. The retained clone, event stream, audit log, diff, and verifier logs stay under `~/.baro/experiments` by default.

## Prepare a fair case

Use a clean git repository and an unexecuted `prd.json`. Both arms receive the exact PRD bytes, so planning randomness is outside the comparison. Every story should have concrete acceptance criteria and test commands, and all `passes` fields must be false.

Freeze the provider harness as well as Baro and the target base. Claude Code can
auto-update while a paired experiment is running; if the
`claude_system.raw.claude_code_version` values in `audit.jsonl` differ between
or within trials, treat small timing/token differences as confounded and mark
the comparison inconclusive.

Choose verification that measures the requested outcome, not Baro's own success report. Ideally, keep holdout tests outside the target repository until after the agents finish. A `--verify` command may reference or copy those external tests because verification runs only after the runtime has stopped; the captured `diff.patch` is produced before verification.

The checked-in protocol holdouts can be type-checked without copying them into
the trial or changing the trial repository. The verifier runs TypeScript with
`noEmit` and resolves only the holdout's `./protocol.js` import to the trial's
`src/protocol.ts`:

```bash
BARO_CHECKOUT=/absolute/path/to/baro
cd "$BARO_CHECKOUT"

node --import tsx packages/baro-orchestrator/scripts/ab-run.ts \
  --repo /absolute/path/to/baro-protocol \
  --base <frozen-ref-before-the-change> \
  --prd "$BARO_CHECKOUT/docs/benchmarks/protocol-run-dispatch.prd.json" \
  --setup "npm install --ignore-scripts --no-package-lock" \
  --verify "npm run build" \
  --verify "node $BARO_CHECKOUT/docs/benchmarks/verify-typescript-holdout.mjs $BARO_CHECKOUT/docs/benchmarks/protocol-run-dispatch-holdout.ts"
```

Use a base from before the requested protocol change. The current
`baro-protocol` default branch may already contain the run-level messages, in
which case running this PRD against `HEAD` would measure nothing.

Do not put credentials in command-line arguments. Provider credentials remain environment variables and their values are not written to the experiment manifest.

Install the Baro workspace dependencies once:

```bash
cd /path/to/baro
npm install
```

The A/B harness works without a prebuilt optional memory package. To exercise
semantic memory from a source checkout as well, build it once:

```bash
npm run build --workspace @baro/memory
```

For a single disposable local run, with Baro-owned pushes and PR creation disabled:

```bash
cargo run -p baro-tui -- \
  --cwd /absolute/path/to/disposable-target \
  --coordination collective \
  --local-only \
  "your goal"
```

The equivalent environment switches are `BARO_COORDINATION=collective` and `BARO_LOCAL_ONLY=1`. Omit them to keep the legacy Conductor coordination path as the default.
Because story agents can execute arbitrary shell commands, `--local-only` is not an OS/network sandbox. Remove remotes from the disposable target clone when you need a hard no-push boundary; the paired A/B harness does this automatically before each arm and rechecks it after setup.

### Optional conversation participant

`--with-dialogue` joins a disposable DialogueAgent to the same Mozaik bus. It
builds a bounded, sanitized view from semantic events and invokes a text-only
Claude or OpenAI-compatible model only after an explicit user message. The
backing model receives no codebase tools. Its only optional action is a bounded
`AgentTargetedMessage` to a worker that currently holds a lease; it cannot
offer work, bid, grant a lease, replan, merge, verify, or complete a run.

```bash
cargo run -p baro-tui -- \
  --cwd /absolute/path/to/remote-free-target \
  --coordination collective \
  --local-only \
  --with-dialogue \
  --dialogue-llm claude \
  --dialogue-model haiku \
  "your goal"
```

Enabling it without sending a message makes no model call. The direct
orchestrator/headless stdin command is:

```json
{"type":"dialogue_message","message_id":"user-1","text":"What is blocked, and why?"}
```

Replies are semantic `conversation_responded` events and are mirrored to the
`_dialogue` story log only when they originate from the bound DialogueAgent
object. In the interactive Rust TUI, press `c` to open the collective lane;
the existing `m` shortcut continues to target a specific running story.

### Exercise the worker market through the real `baro` CLI

The checked-in [candidate file](collective-workers.example.json) is deliberately a configuration example, not a price/quality claim. Its cost, latency and success values are placeholders so the deterministic policy can be exercised. Replace the model IDs with the IDs exposed by your gateway and calibrate all estimates from repeated externally verified trials before making routing decisions from them. A static file must use `"estimateSource":"configured"`; `historical` is reserved for a future measured-data source.

On a disposable clone whose git remotes have been removed:

```bash
export JIGJOY_API_KEY='...'

cargo run -p baro-tui -- \
  --cwd /absolute/path/to/remote-free-target \
  --coordination collective \
  --local-only \
  --llm jigjoy \
  --collective-workers /absolute/path/to/baro/docs/collective-workers.example.json \
  --collective-bid-window-ms 100 \
  --collective-min-success 0.75 \
  "your goal"
```

In the example, the `0.75` floor rejects the cheaper candidate whose configured success estimate is `0.68`; removing the floor lets the scorer compare expected cost per verified success. This proves policy and routing mechanics only. It does not prove either model is actually cheaper or better.

For an already prepared `prd.json`, bypass intake/planning and exercise only the orchestrator:

```bash
export OPENAI_API_KEY="$JIGJOY_API_KEY"
export OPENAI_BASE_URL="${BARO_JIGJOY_URL:-https://gw.baro.jigjoy.ai/v1}"

node --import tsx packages/baro-orchestrator/scripts/cli.ts \
  --cwd /absolute/path/to/remote-free-target \
  --prd prd.json \
  --coordination collective \
  --local-only \
  --collective-workers /absolute/path/to/baro/docs/collective-workers.example.json \
  --collective-bid-window-ms 100 \
  --collective-min-success 0.75 \
  --with-critic \
  --audit-log /tmp/baro-collective-audit.jsonl
```

Keep `--local-only` and a remote-free disposable clone for the first runs. Credentials are resolved locally; the event bus receives only `routeId`, backend and model, never the API key or endpoint URL.

Validate without writing anything:

```bash
node --import tsx packages/baro-orchestrator/scripts/ab-run.ts \
  --repo /path/to/target \
  --prd /path/to/cases/my-task.prd.json \
  --setup "npm ci --ignore-scripts" \
  --verify "npm test" \
  --orchestrator-arg=--llm \
  --orchestrator-arg=claude \
  --orchestrator-arg=--parallel \
  --orchestrator-arg=4 \
  --orchestrator-arg=--with-critic \
  --dry-run
```

The validation fails if the target is dirty, the base already tracks the reserved `.baro-experiment-prd.json` path, the PRD has completed stories, the results directory is inside the source repository, or a harness-owned safety flag is overridden. A repository may keep its normal `prd.json`; the harness never overwrites it.

For the first autonomy comparison, prefer Claude Code or Mozaik-native OpenAI
when you specifically want live corrective turns. Native OpenAI runs an
in-process, multi-round inference/tool loop. Claude Code uses a multi-turn CLI
participant. Codex, OpenCode and Pi story workers are one-shot CLI processes,
so they cannot consume a corrective message after exit. Their terminal output
is nevertheless projected into the same backend-neutral Critic contract: a
failed verdict blocks integration and becomes a recovery/escalation event
instead of silently passing.

## Run the paired experiment

Remove `--dry-run` and use at least three repetitions for a meaningful directional signal:

```bash
node --import tsx packages/baro-orchestrator/scripts/ab-run.ts \
  --case-name websocket-refactor \
  --repo /path/to/target \
  --base HEAD \
  --prd /path/to/cases/websocket-refactor.prd.json \
  --runs 3 \
  --setup "npm ci --ignore-scripts" \
  --verify-input /absolute/path/to/hidden-holdout.mjs \
  --verify "npm run typecheck" \
  --verify "npm test" \
  --verify "node /absolute/path/to/hidden-holdout.mjs" \
  --orchestrator-arg=--llm \
  --orchestrator-arg=claude \
  --orchestrator-arg=--parallel \
  --orchestrator-arg=4 \
  --orchestrator-arg=--timeout \
  --orchestrator-arg=900 \
  --orchestrator-arg=--with-critic
```

The harness adds these arguments itself:

```text
--coordination legacy|collective
--local-only
--cwd <isolated clone>
--prd .baro-experiment-prd.json
--audit-log <trial artifact path>
```

The arms never overlap. Repetition one runs legacy then collective; repetition two reverses the order, and so on. Alternating order reduces warm-cache and time-of-day bias, while sequential execution avoids machine-load and provider-rate-limit interference.

The manifest records the SHA-256 and size of every `--verify-input`. Literal absolute file arguments in `--verify` commands are detected automatically as well; use explicit `--verify-input` for paths assembled through shell variables or other dynamic syntax. The harness checks those bytes before and after every arm, so a changed hidden oracle stops the comparison instead of silently changing the benchmark.

If dependency installation changes tracked files or leaves nonignored untracked files, setup stops before either agent can run. Fix the setup command or commit the required baseline files instead of allowing the two arms to start from an ambiguous state. After setup the harness removes remotes again, disables hooks/signing again, verifies object isolation, and deletes local branch refs so the requested base cannot drift.

## Read the result

The command prints the path to `report.md`. Each trial directory contains:

```text
runs/01-legacy/
  repo/                  retained result clone
  trial-manifest.json    exact arm, base, command and verifier hashes
  events.jsonl           Baro stdout protocol
  audit.jsonl            Mozaik bus audit
  stderr.log             orchestrator diagnostics
  diff.patch             base-to-result diff, captured before verification
  metrics.json           parsed events, git and verifier metrics
  setup-*.log            setup output
  verify-*.log           external verification output
```

If an orchestrator arm crashes or times out, the harness still runs and records the paired artifacts where possible, writes the report, and exits non-zero so an incomplete comparison cannot look successful. Story attempts observed in the durable audit but missing a terminal `model_usage` record are added as explicit unknown observations; token/cost coverage therefore cannot read as complete merely because an aborted provider process omitted its usage frame.

Runtime adaptation counters also come exclusively from the durable Mozaik
audit: proposed, committed and rejected proposal identities remain separate.
Applied commits are deduplicated by run/proposal/commit version, while raw
Applied delivery count remains visible so idempotent replay is observable.
`Committed replans` uses raw legacy `Replan` decisions for the legacy arm and
unique authoritative Applied commits for the collective arm. It never adds
the stdout/TUI projection, which would count the same adaptation twice.

Judge in this order:

1. Did all external/holdout checks pass?
2. Does a blind review of the anonymized diff satisfy the goal and acceptance criteria?
3. Is all required work integrated, without silent merge loss or unrelated damage?
4. Only then compare retries, wall time, token use, estimated cost, replans, recoveries, and peer messages.

More messages, more changed lines, or Baro reporting success do not demonstrate a better result. `report.md` intentionally presents the measurements side by side and does not manufacture a single "autonomy score."

The harness detects if the target repository or Baro's orchestrator source changes between arms and marks the experiment untrustworthy. This is a reproducibility guard, not an OS security boundary: run only trusted setup and verification commands, and use disposable repositories for adversarial tasks.
On macOS and Linux, each command runs in its own process group and the whole group is terminated before the next arm. Windows cannot provide the same guarantee through Node's process API alone, so do not background child processes from Windows setup or verification commands.
