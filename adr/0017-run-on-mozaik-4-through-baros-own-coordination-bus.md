# ADR-0017: Run on Mozaik 4 through Baro's own coordination bus

**Status:** Accepted
**Context:** Mozaik 4 replaced the runtime Baro was built on. `AgenticEnvironment`, `BaseObserver` and the v3
`Participant` are gone: participants now join a runtime created by `defineRuntime`, and events reach them through
situation handlers. `SemanticEvent` carries `payload` (was `data`), a `producerId` and an `occurredAt`. Context
items lost `toJSON`. The model classes (`Gpt55`, `Gpt54`, ...) and `InferenceRequest` are gone; endpoints take an
`InferenceInput` and expose their request/reply mapping as a public `endpointMapper`. Baro used these in some 150
files, and leaned on Mozaik 3 internals (`buildRequest`, the private SDK client) in its OpenAI runtime.

**Decision:**
- Baro owns its coordination runtime. `CoordinationBus` and `BusMember` (`runtime/coordination.ts`) replace
  `AgenticEnvironment` and `BaseObserver`/`Participant`. Each bus runs on its own Mozaik runtime: a member is a
  Mozaik participant whose one situation handler routes every event to the member's hooks. The delivery contract
  observers rely on is unchanged: a publish reaches every member synchronously in join order; the publisher gets
  `onInternalEvent`, everyone else `onExternalEvent(source, event)`; handlers are not awaited.
- An event is delivered as the object that was published. Observers compare events by identity, so the bus passes
  the publisher as `source` instead of stamping it into a copy; Baro's events carry `UNSTAMPED_PRODUCER`.
- Model items (function calls and their output, model messages, reasoning) travel on the bus as semantic events
  of `baro.bus.*` types and arrive at the same `onExternal*` hooks as before.
- `runtime/mozaik.ts` stays the only importer of `@mozaik-ai/core` (enforced by `mozaik-port.test.ts`); it adds
  `toWire`, the wire shape Mozaik 3's `toJSON` produced, which logs and transcripts keep.
- The OpenAI runtime uses public Mozaik 4 surfaces only: requests and replies are mapped by the endpoints'
  `endpointMapper`; Baro owns the OpenAI SDK client (one per endpoint, without SDK retries for billed calls).
  `InferenceModel` is Baro's model handle; OpenAI's own models take their specification from Mozaik's
  `supportedModels`, every other name is a `GenericOpenAIModel`. Stateless Responses reasoning replay keeps each
  item's wire form (its id included), which Mozaik's mapper drops.
- The mechanical part of the change (`data` to `payload`, generics, class and method renames, `toJSON` call sites)
  was made with type-checked codemods, so every edit is a rename the compiler agreed with.

**Consequences:** Observers, forwarders and harness lanes change only their imports and base class. A later Mozaik
release lands in `runtime/coordination.ts`, `runtime/mozaik.ts` and `harness/openai/runtime.ts`. Mozaik's own
`producerId` is empty on Baro's events; anything that needs the publisher reads `source`.
