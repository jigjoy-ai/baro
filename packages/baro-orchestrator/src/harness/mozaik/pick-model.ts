/**
 * Name → model, for every lane that runs inference in this process.
 *
 * Kept out of the story agent so a second caller does not fork a second copy
 * of the one rule that matters here: a custom endpoint always takes the
 * generic model, because the built-in gpt-5.x classes bind to OpenAI's own
 * endpoint and cannot be redirected at one.
 */

import {
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    type GenerativeModel,
} from "../../runtime/mozaik.js"
import { GenericOpenAIModel, type OpenAIConnection } from "../openai/runtime.js"

export function pickInferenceModel(
    name: string,
    connection?: OpenAIConnection,
): GenerativeModel {
    if (!name) {
        // Reaching here nameless means a phase landed on the native lane by
        // fallback — a backend with no interactive lane adapter (#121). Fail
        // with the cause, not an OpenAI credentials error three calls later.
        throw new Error(
            "pick-model: no model name for the native lane — this backend has no interactive lane adapter",
        )
    }
    if (connection?.baseURL) return new GenericOpenAIModel(name, connection)
    switch (name) {
        case "gpt-5.5":
            return new Gpt55()
        case "gpt-5.4":
            return new Gpt54()
        case "gpt-5.4-mini":
            return new Gpt54Mini()
        case "gpt-5.4-nano":
            return new Gpt54Nano()
        default:
            process.stderr.write(
                `[pick-model] Using model "${name}" as-is with the OpenAI API.\n`,
            )
            return new GenericOpenAIModel(name)
    }
}
