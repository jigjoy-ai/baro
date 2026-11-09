# Where Baro works around Mozaik

Baro runs on Mozaik 4 (`@mozaik-ai/core`, imported only through
`packages/baro-orchestrator/src/runtime/mozaik.ts`). In a few places Baro adds or
replaces something Mozaik does not offer yet. Each entry says what Baro does, why,
and what Mozaik could provide so Baro can drop its own version. Keep this list
current when a workaround is added or removed.

## Runtime and coordination

**1. Publisher identity and internal/external delivery** —
`runtime/coordination.ts` (`CoordinationBus`, `BusMember`).
A Mozaik event carries a `producerId` string, and every participant's situation
handlers see every event, including their own. Baro's observers need the
publishing participant *object* (to authenticate the source, e.g. "only the Board
may decide this") and a separate hook for their own events (`onInternalEvent`)
versus everyone else's (`onExternalEvent(source, event)`). Baro wraps each member
in a participant seat and passes the publisher through a delivery stack, and
publishes events with an empty producer id (`UNSTAMPED_PRODUCER`) so the object
is never re-stamped. *Mozaik could:* hand handlers the publishing participant (not
only its id) and let a participant opt out of its own events.

**2. Event identity** — `runtime/coordination.ts`, `events/define.ts`.
Observers compare events by object identity and Baro freezes payloads at the
producer, so the bus must deliver the exact object that was published. *Mozaik
could:* document (and test) that `publish` delivers the same instance to every
participant without copying or stamping.

**3. Model items on the bus** — `runtime/coordination.ts` (`baro.bus.*` types).
Function calls, their outputs, model messages and reasoning travel between agents
as Mozaik context items, not semantic events. Baro wraps them in `baro.bus.*`
events and unwraps them for `onExternalFunctionCall` and friends. *Mozaik could:*
let context items be published on the runtime as first-class messages.

**4. Ordered, awaited handlers** — `runtime/serialized-observer.ts`.
Mozaik calls handlers synchronously and does not await them. Baro gives each
participant an ordered async mailbox, keyed background tasks and a failure hook,
so an async handler finishes before the next event for that participant is
handled and a thrown handler is reported instead of lost. *Mozaik could:* offer an
opt-in serialized delivery mode per participant with failure reporting.

**5. Lifecycle events** — `runtime/coordination.ts` (`MOZAIK_LIFECYCLE`).
`participant.joined` / `participant.left` reach every handler; Baro filters them
out because its members join through `BusMember.join`. *Mozaik could:* make
lifecycle events opt-in, or a separate handler kind.

## Context and wire format

**6. Serialization** — `runtime/mozaik.ts` (`toWire`).
Mozaik 4 removed `toJSON` from context items and `ModelContext`. Audit logs and
their readers (replay tooling, kaleidoskop) keep Mozaik 3's wire shape, so Baro
re-implements it. *Mozaik could:* ship a stable, versioned serializer (and its
inverse) for context items, contexts and events.

## Inference

**7. Model catalogue** — `harness/openai/runtime.ts` (`GenericOpenAIModel`).
`supportedModels` lists known models only; any other name (an OpenAI-compatible
endpoint such as Hermes's proxy, OpenRouter or vLLM) has no specification. Baro
treats unknown names as a generic model with no reasoning-effort support. *Mozaik
could:* accept an ad-hoc specification for an unlisted model on an
OpenAI-compatible endpoint.

**8. Stateless reasoning replay** — `harness/openai/runtime.ts` (`reasoningWire`).
With `store: false`, a reasoning item must go back to the Responses API exactly as
the provider sent it, id and encrypted content included; Mozaik's mapper does not
keep the id. Baro remembers each item's wire form and substitutes it when it
builds the next request. *Mozaik could:* preserve provider ids and encrypted
content on `ReasoningItem` and replay them.

**9. Output ceiling on Chat Completions** — `harness/openai/runtime.ts`
(`withOutputCeiling`). Baro always states an output ceiling so a cut reply is a
`finish_reason: "length"` it can act on. Mozaik 4's chat mapper sends `max_tokens`
when `maxOutputTokens` is set, which reasoning models behind Chat Completions
reject (they want `max_completion_tokens`). *Mozaik could:* choose the parameter
per model specification. (The function's comment predates Mozaik 4, which does
send `max_tokens`; it should be corrected when this is addressed.)

**10. HTTP client ownership** — `harness/openai/runtime.ts` (`providerClient`).
Baro owns the OpenAI SDK client per endpoint so billed calls run without SDK
retries (a retry would be billed twice through the gateway) and so it can stream
and set transport options. *Mozaik could:* let the caller supply the client or its
retry and transport policy per endpoint.

## The agent loop

Baro does not use Mozaik's `runLoop`: the native lane has its own loop
(`harness/openai/story-agent.ts`) and the Claude lane wraps the Claude Code CLI
as a participant (`harness/claude/cli-participant.ts`). These are the reasons, read
from `@mozaik-ai/core@4.2.0`.

**11. One tool call per inference** — `harness/openai/story-agent.ts`,
`harness/openai/runtime.ts` (`withParallelToolCalls`).
`runLoop` executes the first `function_call` of a reply and drops the rest, and
puts only that call and its output back into the context, so reasoning items are
lost between rounds. Baro asks the provider for parallel calls, runs every call of
a round (read-only ones concurrently), and keeps reasoning in the context.
*Mozaik could:* run all calls of a reply, concurrently where the tool declares it
safe, and append every inference item to the context.

**12. Forking a context** — `harness/session-lineage.ts`.
`ModelContext` is mutated in place and has no copy. A story that builds on another
story starts from that story's context (native lane: the parent's items up to its
last completed round; Claude lane: `claude --resume <id> --fork-session`), so it
does not re-read what its parent studied, and the provider's prompt cache serves
the shared prefix. *Mozaik could:* offer `context.fork()` at a consistent point (no
call without its output) and a fork of a running agent as a runtime operation.

**13. Cache hints** — not worked around.
The Anthropic and OpenAI mappers send no `cache_control` or `prompt_cache_key`.
Baro's native lane relies on OpenAI's automatic prefix cache; a native Anthropic
lane would pay for the whole context on every round. *Mozaik could:* mark the
stable prefix for providers that need it.

**14. Cancellation, retries, messages between rounds** —
`harness/openai/story-agent.ts` (`abortController`, `runRoundWithTransportRetries`,
`pendingPeerNotes`). `runLoop` takes no abort signal, has no retry or timeout, and
no place to hand an agent a peer's message between two rounds short of writing an
`InterceptionHandler`. Baro's loop has all three. *Mozaik could:* accept a signal,
a retry policy, and an inbox drained at round boundaries.

**15. Agents whose loop runs elsewhere** — `harness/claude/`, `harness/codex/`,
`harness/opencode/`, `harness/pi/`, `harness/devin/`.
A participant is an `agent` or a `human`; Baro wraps CLI agents as bus members and
maps their output to context items itself. *Mozaik could:* define a session
interface (send a message, observe items, fork, stop) with the native loop as one
implementation and an external agent as another.

## Coordination features Baro built itself

These are not workarounds but candidates for Mozaik, because any multi-agent
runtime with shared resources needs them:

**16. Resource ownership and claims** — `execution/write-surface.ts`,
`execution/collective-board.ts` (`claimPaths`). Agents declare and claim the
resources (files) they write; a resource another active agent holds is refused,
and ownership is released when the holder finishes.

**17. Checkpoints and early start** — `execution/collective-board.ts`
(`onCheckpointRequested`, `holdForPrerequisites`). A running agent publishes a
stable part of its work; dependents start on it and finish only after it does.
A Mozaik primitive for "this participant's partial output is ready for these
dependents" would let other Mozaik applications coordinate dependent work the
same way.

**18. Delegate and join** — `execution/collective-board.ts`
(`sessionSourceFor`, `splitSelfDependency`), `harness/session-lineage.ts`.
An agent adds stories for independent parts of its task and makes them its own
prerequisites; they run in parallel as forks of its session, and it is resumed in
that session when they have integrated.
