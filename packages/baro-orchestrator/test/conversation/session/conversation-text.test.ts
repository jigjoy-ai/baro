import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import {
    MAX_CONVERSATION_TEXT_CHARS,
    boundedConversationTextOrThrow,
} from "../../../src/conversation/session/conversation-text.js"

function throwsTypeError(message: string): (error: unknown) => boolean {
    return (error: unknown) => error instanceof TypeError && error.message === message
}

describe("bounded conversation text", () => {
    it("names an empty or whitespace-only goal as empty", () => {
        assert.throws(
            () => boundedConversationTextOrThrow("", "the goal"),
            throwsTypeError("the goal is empty"),
        )
        assert.throws(
            () => boundedConversationTextOrThrow(" \r\n\t \n", "the goal"),
            throwsTypeError("the goal is empty"),
        )
    })

    it("names the length and the limit of a too-long goal", () => {
        assert.throws(
            () => boundedConversationTextOrThrow("x".repeat(11_245), "the goal"),
            throwsTypeError("the goal is 11,245 characters; the limit is 8,000"),
        )
    })

    it("accepts exactly the limit and returns the text unchanged", () => {
        assert.equal(MAX_CONVERSATION_TEXT_CHARS, 8_000)
        const text = "y".repeat(8_000)
        assert.equal(boundedConversationTextOrThrow(text, "the goal"), text)
    })

    it("names an unsafe control character and its 1-based position", () => {
        assert.throws(
            () => boundedConversationTextOrThrow("abc\u000bdef", "the goal"),
            throwsTypeError("the goal contains an unsafe control character U+000B at position 4"),
        )
        assert.throws(
            () => boundedConversationTextOrThrow("  ok\u007f", "the repository query"),
            throwsTypeError(
                "the repository query contains an unsafe control character U+007F at position 3",
            ),
        )
    })

    it("still refuses a non-string value with the type message", () => {
        assert.throws(
            () => boundedConversationTextOrThrow(42, "the goal"),
            throwsTypeError("conversation text must be a string"),
        )
    })

    it("normalizes line endings and trims before checking", () => {
        assert.equal(
            boundedConversationTextOrThrow("  first\r\nsecond\rthird  ", "the goal"),
            "first\nsecond\nthird",
        )
    })
})
