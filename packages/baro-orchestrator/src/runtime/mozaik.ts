/**
 * Anti-corruption port around `@mozaik-ai/core` (v4).
 *
 * Every Baro module imports Mozaik symbols from here, never from the package
 * directly; the coordination runtime itself is Baro's (./coordination.ts) and
 * only it touches Mozaik's runtime types. Enforced by
 * test/runtime/mozaik-port.test.ts.
 */

export {
    ContextItem,
    defineRuntime,
    FunctionCallItem,
    FunctionCallOutputItem,
    InputTokenDetails,
    ModelContext,
    ModelMessageItem,
    OpenAIChatCompletions,
    OpenAIResponses,
    OutputTokenDetails,
    Participant,
    ReasoningItem,
    RuntimeState,
    SemanticEvent,
    SituationSpecification,
    SystemMessageItem,
    TokenUsage,
    UserMessageItem,
} from "@mozaik-ai/core"

export type { InferenceInput, InferenceOutput, SituationContext, Tool } from "@mozaik-ai/core"

/** Producer id of Baro's events: the coordination bus passes the publisher as `source` instead. */
export const UNSTAMPED_PRODUCER = ""

import {
    ContextItem as MozaikContextItem,
    DeveloperMessageItem,
    FunctionCallItem as MozaikFunctionCallItem,
    FunctionCallOutputItem as MozaikFunctionCallOutputItem,
    ModelMessageItem as MozaikModelMessageItem,
    ReasoningItem as MozaikReasoningItem,
    SystemMessageItem as MozaikSystemMessageItem,
    UserMessageItem as MozaikUserMessageItem,
} from "@mozaik-ai/core"

const text = (content: { type: string; text: string }) => [{ type: content.type, text: content.text }]

/** The Responses-API wire shape of a context item, as Mozaik 3's `toJSON` produced it (logs and transcripts keep it). */
export function toWire(item: MozaikContextItem): unknown {
    if (
        item instanceof MozaikUserMessageItem ||
        item instanceof MozaikSystemMessageItem ||
        item instanceof DeveloperMessageItem ||
        item instanceof MozaikModelMessageItem
    ) {
        return { type: item.type, role: item.role, content: text(item.content) }
    }
    if (item instanceof MozaikFunctionCallItem) {
        return { type: item.type, call_id: item.callId, name: item.name, arguments: item.args }
    }
    if (item instanceof MozaikFunctionCallOutputItem) {
        return { type: item.type, call_id: item.callId, output: text(item.output) }
    }
    if (item instanceof MozaikReasoningItem) {
        return {
            type: item.type,
            content: item.content ? text(item.content) : undefined,
            encryptedContent: item.encryptedContent,
            summary: item.summary.map(text),
        }
    }
    return { type: item.type }
}
