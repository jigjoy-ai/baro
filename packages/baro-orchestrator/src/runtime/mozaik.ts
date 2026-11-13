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
    supportedModels,
    SystemMessageItem,
    TokenUsage,
    UserMessageItem,
} from "@mozaik-ai/core"

export type { InferenceInput, InferenceOutput, SituationContext, Tool } from "@mozaik-ai/core"

/** Producer id of Baro's events: the coordination bus passes the publisher as `source` instead. */
export const UNSTAMPED_PRODUCER = ""

import {
    ContextItem as MozaikContextItem,
    SemanticEvent as MozaikSemanticEvent,
    ModelContext as MozaikModelContext,
    DeveloperMessageItem,
    FunctionCallItem as MozaikFunctionCallItem,
    FunctionCallOutputItem as MozaikFunctionCallOutputItem,
    ModelMessageItem as MozaikModelMessageItem,
    ReasoningItem as MozaikReasoningItem,
    SystemMessageItem as MozaikSystemMessageItem,
    UserMessageItem as MozaikUserMessageItem,
} from "@mozaik-ai/core"

const text = (content: { type: string; text: string }) => [{ type: content.type, text: content.text }]

export type WireText = Array<{ type: string; text: string }>
export interface WireMessage { type: string; role: string; content: WireText }
export interface WireFunctionCall { type: string; call_id: string; name: string; arguments: string }
export interface WireFunctionCallOutput { type: string; call_id: string; output: WireText }
export interface WireReasoning {
    type: string
    content: WireText | undefined
    encryptedContent: string | undefined
    summary: WireText[]
}
export interface WireOtherItem { type: string }
export type WireContextItem = WireMessage | WireFunctionCall | WireFunctionCallOutput | WireReasoning | WireOtherItem
export interface WireSemanticEvent<TType extends string, TPayload> { type: TType; data: TPayload }
export type WireValue = WireContextItem | WireContextItem[] | WireSemanticEvent<string, unknown>

/**
 * The wire shape Mozaik 3's `toJSON` produced: Responses-API items (a context is its items), events as `{ type, data }`.
 * Audit logs and their readers (replay tooling, kaleidoskop) keep this shape.
 */
export function toWire<TType extends string, TPayload>(
    item: MozaikSemanticEvent<TType, TPayload>,
): WireSemanticEvent<TType, TPayload>
export function toWire(item: MozaikModelContext): WireContextItem[]
export function toWire(
    item: MozaikUserMessageItem | MozaikSystemMessageItem | DeveloperMessageItem | MozaikModelMessageItem,
): WireMessage
export function toWire(item: MozaikFunctionCallItem): WireFunctionCall
export function toWire(item: MozaikFunctionCallOutputItem): WireFunctionCallOutput
export function toWire(item: MozaikReasoningItem): WireReasoning
export function toWire(item: MozaikContextItem): WireContextItem
export function toWire(item: MozaikContextItem | MozaikSemanticEvent<string, unknown> | MozaikModelContext): WireValue
export function toWire(item: MozaikContextItem | MozaikSemanticEvent<string, unknown> | MozaikModelContext): WireValue {
    if (item instanceof MozaikSemanticEvent) return { type: item.type, data: item.payload }
    if (item instanceof MozaikModelContext) return item.getItems().map((i) => toWire(i))
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
