export interface FakeCompletionUsage {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
}

/** The SDK sets `stream` in the request body, not in a header or the path. */
export function streamRequested(body: string): boolean {
    if (!body) return false
    try {
        return (JSON.parse(body) as { stream?: unknown }).stream === true
    } catch {
        return false
    }
}

/**
 * The chunk sequence a chat-completions provider sends: content, a finish
 * reason, then a choice-less frame carrying usage. Usage arrives last and
 * separately — a fixture that attaches it to the content chunk would hide
 * the case the streaming reader exists to handle.
 */
export function streamedCompletion(
    content: string,
    usage: FakeCompletionUsage,
): unknown[] {
    return [
        {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [
                {
                    index: 0,
                    delta: { role: "assistant", content },
                    finish_reason: null,
                },
            ],
        },
        {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
        {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [],
            usage,
        },
    ]
}
