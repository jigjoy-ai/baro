/**
 * A streamed chat-completions round, assembled into the items a round returns.
 *
 * THIS FILE IS MOZAIK'S JOB, HELD HERE UNTIL MOZAIK DOES IT. Its adapter
 * (`OpenAICompatibleChatCompletions`) exposes `stream()`, but 3.12 sends no
 * `stream_options.include_usage` — so a streamed round reports no tokens at
 * all — and yields raw `chat.completion.chunk` events without assembling them
 * into context items. Cache-accurate usage is what every cost figure and every
 * gateway receipt is built on, which is why the non-streamed path stayed.
 *
 * DELETING THIS: when a Mozaik release both requests usage and assembles
 * chunks, `streamChatRound` has one caller (`inferChatRound`) and its output
 * is the same `{ items, usage }` the non-streamed path produces. Replace the
 * call, delete this file and its test. Nothing else knows it exists.
 *
 * Why it is worth holding at all: a non-streamed completion sends nothing —
 * not even a header — until the whole answer exists, so a three-minute
 * generation is indistinguishable from a hang, and every liveness signal Baro
 * has measures silence. A streamed round makes progress observable per chunk,
 * which is what lets the idle watchdog tell a working model from a dead one.
 */

import {
    FunctionCallItem,
    InputTokenDetails,
    ModelMessageItem,
    OutputTokenDetails,
    TokenUsage,
    type ContextItem,
} from "../../runtime/mozaik.js"

/** The provider client this module needs, and nothing more. */
export interface ChatStreamClient {
    chat: {
        completions: {
            create(
                body: Record<string, unknown>,
                options?: Record<string, unknown>,
            ): Promise<AsyncIterable<ChatCompletionChunk>>
        }
    }
}

/** The delta shape of the chat-completions stream, as far as a round cares. */
export interface ChatCompletionChunk {
    readonly choices?: ReadonlyArray<{
        readonly delta?: {
            readonly content?: string | null
            /** Read for liveness only — see the assembly note below. */
            readonly reasoning_content?: string | null
            readonly tool_calls?: ReadonlyArray<{
                readonly index?: number
                readonly id?: string
                readonly function?: {
                    readonly name?: string
                    readonly arguments?: string
                }
            }>
        }
    }>
    readonly usage?: {
        readonly prompt_tokens?: number
        readonly completion_tokens?: number
        readonly total_tokens?: number
        readonly prompt_tokens_details?: { readonly cached_tokens?: number }
        readonly completion_tokens_details?: { readonly reasoning_tokens?: number }
    } | null
}

export interface ChatStreamOptions {
    readonly signal?: AbortSignal
    /** Per-chunk proof of life. Silence is the only honest clock, and this is
     *  what makes silence measurable on a lane that owns its own loop. */
    readonly onActivity?: () => void
    /** Merged into the request options; the caller owns transport concerns. */
    readonly requestOptions?: Record<string, unknown>
}

export interface ChatStreamRound {
    readonly items: ContextItem[]
    /**
     * Undefined when the provider streamed no usage frame — a state the
     * caller must keep as "not reported" rather than zero. A missing number
     * and a free round are not the same fact.
     */
    readonly usage: TokenUsage | undefined
}

/**
 * Run one streamed round and return what the non-streamed path would have.
 *
 * Item order matches Mozaik's own reader: the message, then every tool call
 * in the order the provider indexed them.
 */
export async function streamChatRound(
    client: ChatStreamClient,
    body: Record<string, unknown>,
    options: ChatStreamOptions = {},
): Promise<ChatStreamRound> {
    const stream = await client.chat.completions.create(
        {
            ...body,
            stream: true,
            // Without this a streamed round carries no usage at all, and
            // every cost figure downstream is built on usage.
            stream_options: { include_usage: true },
        },
        {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.requestOptions ?? {}),
        },
    )

    let content = ""
    let usage: TokenUsage | undefined
    // Keyed by the provider's index: a single call's name and arguments arrive
    // across many chunks, and arguments arrive as fragments of one JSON string.
    const calls = new Map<number, { id: string; name: string; args: string }>()

    for await (const chunk of stream) {
        options.onActivity?.()
        if (chunk.usage) usage = tokenUsageOf(chunk.usage)
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue
        if (typeof delta.content === "string") content += delta.content
        for (const [index, part] of (delta.tool_calls ?? []).entries()) {
            const key = typeof part.index === "number" ? part.index : index
            const call = calls.get(key) ?? { id: "", name: "", args: "" }
            if (part.id) call.id = part.id
            if (part.function?.name) call.name = part.function.name
            if (part.function?.arguments) call.args += part.function.arguments
            calls.set(key, call)
        }
    }

    // Reasoning deltas are read and dropped on purpose. Mozaik's non-streamed
    // reader turns `reasoning_content` into a ReasoningItem, but its request
    // builder maps System/User/Message/FunctionCall/FunctionCallOutput and
    // nothing else — a reasoning item in the context never reaches the
    // provider on this lane. Carrying one here would differ from the
    // non-streamed path only in what we store and never send.
    const items: ContextItem[] = []
    if (content) items.push(ModelMessageItem.rehydrate({ text: content }))
    for (const key of [...calls.keys()].sort((a, b) => a - b)) {
        const call = calls.get(key)!
        items.push(
            FunctionCallItem.rehydrate({
                callId: call.id,
                name: call.name,
                // A tool call with no arguments streams none; the invoker
                // parses this, and `{}` is what it expects to see.
                args: call.args || "{}",
            }),
        )
    }
    return { items, usage }
}

function tokenUsageOf(
    raw: NonNullable<ChatCompletionChunk["usage"]>,
): TokenUsage {
    return new TokenUsage(
        raw.prompt_tokens ?? 0,
        raw.completion_tokens ?? 0,
        raw.total_tokens ?? 0,
        new InputTokenDetails(raw.prompt_tokens_details?.cached_tokens ?? 0),
        new OutputTokenDetails(
            raw.completion_tokens_details?.reasoning_tokens ?? 0,
        ),
    )
}
