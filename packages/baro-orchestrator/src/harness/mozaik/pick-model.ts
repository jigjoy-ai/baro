/**
 * Name → model, for every lane that runs inference in this process.
 *
 * Kept out of the story agent so a second caller does not fork a second copy
 * of the one rule that matters here: a custom endpoint always takes the
 * generic model, because the built-in gpt-5.x classes bind to OpenAI's own
 * endpoint and cannot be redirected at one.
 */

import {
    GenericOpenAIModel,
    nativeOpenAIModel,
    type InferenceModel,
    type OpenAIConnection,
} from "../openai/runtime.js"

export function pickInferenceModel(
    name: string,
    connection?: OpenAIConnection,
): InferenceModel {
    if (!name) {
        // Reaching here nameless means a phase landed on the native lane by
        // fallback — a backend with no interactive lane adapter (#121). Fail
        // with the cause, not an OpenAI credentials error three calls later.
        throw new Error(
            "pick-model: no model name for the native lane — this backend has no interactive lane adapter",
        )
    }
    if (connection?.baseURL) return new GenericOpenAIModel(name, connection)
    const native = nativeOpenAIModel(name)
    if (native) return native
    process.stderr.write(
        `[pick-model] Using model "${name}" as-is with the OpenAI API.\n`,
    )
    return new GenericOpenAIModel(name)
}
