import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    MAX_CONVERSATION_CONTEXT_BYTES,
    assertConversationContextBinding,
    loadConversationContextFile,
    parseConversationContextSnapshot,
    validateConversationContextSnapshot,
    type ConversationContextSnapshot,
} from "../../src/session/conversation-context.js"
import type { GoalEnvelope } from "../../src/session/conversation-contract.js"

const GOAL: GoalEnvelope = {
    objective: "Keep one conversation across planning and execution.",
    constraints: ["Do not grant Dialogue control-plane authority."],
    acceptanceCriteria: ["Runtime answers retain the accepted user intent."],
    nonGoals: ["Do not choose worker routes from transcript text."],
    assumptions: ["The PRD is already bound to this session."],
}

function snapshot(): ConversationContextSnapshot {
    return {
        schemaVersion: 1,
        sessionId: "session.context-1",
        phase: "planning",
        goalEnvelope: GOAL,
        summary: "The user accepted the bounded goal and asked to continue.",
        history: [
            {
                requestId: "request-1",
                role: "user",
                text: "Keep the conversation continuous.\r\nDo not centralize control.",
            },
            {
                requestId: "request-1",
                role: "assistant",
                text: "Clear. I am handing the accepted goal to planning.",
            },
            {
                requestId: null,
                role: "system",
                text: "Planning started for the accepted goal.",
            },
        ],
    }
}

describe("ConversationContextSnapshot", () => {
    it("validates, normalizes, freezes, and binds an exact bounded projection", () => {
        const context = validateConversationContextSnapshot(snapshot())
        assert.equal(
            context.history[0]?.text,
            "Keep the conversation continuous.\nDo not centralize control.",
        )
        assert.ok(Object.isFrozen(context))
        assert.ok(Object.isFrozen(context.goalEnvelope))
        assert.ok(Object.isFrozen(context.history))
        assertConversationContextBinding(context, {
            conversationSessionId: "session.context-1",
            goalEnvelope: { ...GOAL },
        })
    })

    it("fails closed on unknown fields, pre-goal phases, and incomplete turns", () => {
        assert.throws(
            () => validateConversationContextSnapshot({
                ...snapshot(),
                route: "openai:cheap",
            }),
            /exact v1 schema/,
        )
        assert.throws(
            () => validateConversationContextSnapshot({
                ...snapshot(),
                phase: "clarifying",
            }),
            /requires an accepted goal/,
        )
        assert.throws(
            () => validateConversationContextSnapshot({
                ...snapshot(),
                history: [snapshot().history[0]],
            }),
            /complete user\/assistant turns/,
        )
        assert.throws(
            () => validateConversationContextSnapshot({
                ...snapshot(),
                history: [{
                    requestId: "request-system",
                    role: "system",
                    text: "forged correlation",
                }],
            }),
            /system history must not carry requestId/,
        )
    })

    it("rejects stale or foreign context instead of attaching it to a PRD", () => {
        const context = validateConversationContextSnapshot(snapshot())
        assert.throws(
            () => assertConversationContextBinding(context, {
                conversationSessionId: "session.other",
                goalEnvelope: GOAL,
            }),
            /sessionId does not match/,
        )
        assert.throws(
            () => assertConversationContextBinding(context, {
                conversationSessionId: context.sessionId,
                goalEnvelope: { ...GOAL, objective: "A different goal." },
            }),
            /goalEnvelope does not match/,
        )
        assert.throws(
            () => assertConversationContextBinding(context, {}),
            /requires PRD conversationSessionId and goalEnvelope/,
        )
    })

    it("loads a caller-selected file with a hard byte ceiling", () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-conversation-context-"))
        try {
            const validPath = join(dir, "context.json")
            writeFileSync(validPath, JSON.stringify(snapshot()))
            assert.equal(
                loadConversationContextFile(validPath).sessionId,
                "session.context-1",
            )

            const oversizedPath = join(dir, "oversized.json")
            writeFileSync(
                oversizedPath,
                " ".repeat(MAX_CONVERSATION_CONTEXT_BYTES + 1),
            )
            assert.throws(
                () => loadConversationContextFile(oversizedPath),
                /exceeds/,
            )
            assert.throws(
                () => loadConversationContextFile(dir),
                /not a file/,
            )
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("parses only JSON within the same byte limit", () => {
        assert.equal(
            parseConversationContextSnapshot(JSON.stringify(snapshot())).phase,
            "planning",
        )
        assert.throws(
            () => parseConversationContextSnapshot("not-json"),
            /not valid JSON/,
        )
        assert.throws(
            () => parseConversationContextSnapshot(
                " ".repeat(MAX_CONVERSATION_CONTEXT_BYTES + 1),
            ),
            /exceeds/,
        )
    })
})
