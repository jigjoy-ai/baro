import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { systemPrompt } from "../../src/operator/operator-session.js"

describe("systemPrompt", () => {
    it("tells the operator to mirror the person's language but keep English for code-facing artefacts", () => {
        const prompt = systemPrompt("/tmp/project")
        assert.ok(prompt.includes("mirror the language of the person's most recent message"))
        assert.ok(prompt.includes("answers, questions, progress notes, and the final report"))
        assert.ok(prompt.includes("switch with them"))
        assert.ok(prompt.includes("Keep English for code-facing artefacts"))
        assert.ok(prompt.includes("commit messages"))
        assert.ok(prompt.includes("goal text passed to `delegate`"))
        assert.ok(prompt.includes("file contents"))
        assert.ok(prompt.includes("identifiers"))
    })

    it("does not describe delivery: no push, PR, or publish instructions", () => {
        const prompt = systemPrompt("/tmp/project")
        assert.doesNotMatch(prompt, /\bpush(e[sd]|ing)?\b/iu)
        assert.doesNotMatch(prompt, /\bpublish(e[sd]|ing)?\b/iu)
        assert.doesNotMatch(prompt, /pull request/iu)
        assert.doesNotMatch(prompt, /\bPR\b/u)
    })
})
