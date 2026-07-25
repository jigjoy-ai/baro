import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveDialogueBackend } from "../src/orchestrate.js"

describe("resolveDialogueBackend", () => {
    it("keeps an explicit supported dialogue backend", () => {
        assert.equal(resolveDialogueBackend("claude", "codex"), "claude")
        assert.equal(resolveDialogueBackend("openai", "codex"), "openai")
        assert.equal(resolveDialogueBackend("codex", "claude"), "codex")
        assert.equal(resolveDialogueBackend("opencode", "claude"), "opencode")
        assert.equal(resolveDialogueBackend("pi", "claude"), "pi")
    })

    it("follows run backends with safe text-only adapters", () => {
        assert.equal(resolveDialogueBackend(undefined, "claude"), "claude")
        assert.equal(resolveDialogueBackend(undefined, "openai"), "openai")
        assert.equal(resolveDialogueBackend(undefined, "codex"), "codex")
        assert.equal(resolveDialogueBackend(undefined, "opencode"), "opencode")
        assert.equal(resolveDialogueBackend(undefined, "pi"), "pi")
    })
})
