import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import { redactCapabilities } from "../src/tui-protocol.js"

// Run logs showed each agent-collab call with its lease's bearer token in the
// clear; the stream feeds terminals, log files and host apps.
describe("the event stream never carries a collaboration token", () => {
    it("redacts --token values and bearer headers in serialized lines", () => {
        const line = JSON.stringify({
            text: 'node "/x/agent-collab.mjs" emit --endpoint "http://127.0.0.1:5/" --token "s3cr3t-token" --kind note',
            other: "--token=s3cr3t-token and Authorization: Bearer s3cr3t.token",
        })
        const redacted = redactCapabilities(line)
        assert.doesNotMatch(redacted, /s3cr3t/)
        assert.match(redacted, /--kind note/, "the rest of the command stays readable")
        assert.doesNotThrow(() => JSON.parse(redacted), "the line is still valid JSON")
    })
})
