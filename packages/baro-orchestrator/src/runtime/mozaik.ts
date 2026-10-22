/**
 * Anti-corruption port around Mozaik. Every Baro module imports Mozaik symbols
 * from here; only src/runtime/mozaik*.ts may name the packages (enforced by
 * test/runtime/mozaik-port.test.ts).
 *
 * The bus runs on the Mozaik v4 runtime (mozaik-runtime.ts). Context items and
 * provider adapters still come from 3.12 under the `mozaik-core-v3` alias
 * until the native inference lane moves to v4's InferenceInput/runLoop.
 */

export {
    AgenticEnvironment,
    BaroRuntimeState,
    BaseObserver,
    createAgent,
    createHuman,
    Participant,
    RuntimeEvent,
    RuntimeParticipant,
    SituationSpecification,
} from "./mozaik-runtime.js"
export type {
    InterceptionHandler,
    SituationContext,
    SituationHandler,
    SituationProcessor,
} from "./mozaik-runtime.js"

export {
    ContextItem,
    FunctionCallItem,
    FunctionCallOutputItem,
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    InferenceRequest,
    InputTokenDetails,
    ModelContext,
    ModelMessageItem,
    OpenAICompatibleChatCompletions,
    OpenAIResponses,
    OutputTokenDetails,
    ReasoningItem,
    SemanticEvent,
    SystemMessageItem,
    TokenUsage,
    UserMessageItem,
} from "mozaik-core-v3"

export type { GenerativeModel, Tool } from "mozaik-core-v3"
