import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ConversationIntake,
    type ConversationResponder,
    type ConversationResponderInput,
} from "../../src/session/conversation-intake.js"

describe("ConversationIntake", () => {
    for (const backend of ["claude", "codex"] as const) {
        it(`uses the same repository-free responder seam for ${backend}`, async () => {
            let observed: ConversationResponderInput | null = null
            const responder: ConversationResponder = {
                backend,
                async respond(input) {
                    observed = input
                    return JSON.stringify(readyWire(input.sessionId, input.requestId))
                },
            }
            const intake = new ConversationIntake({
                sessionId: `session-${backend}`,
                responder,
            })

            const response = await intake.submit({
                requestId: "goal-1",
                text: "Add strict goal intake without changing the DAG authority.",
            })

            assert.equal(response.kind, "ready")
            assert.deepEqual(Object.keys(observed!).sort(), [
                "requestId",
                "sessionId",
                "systemPrompt",
                "userPrompt",
            ])
            assert.equal("cwd" in (observed as unknown as Record<string, unknown>), false)
            assert.equal("tools" in (observed as unknown as Record<string, unknown>), false)
            assert.match(observed!.systemPrompt, /must not request,\s*read, or modify repository files/)
        })
    }

    it("serializes rapid turns so clarification is visible to the answer turn", async () => {
        const firstGate = deferred()
        const calls: ConversationResponderInput[] = []
        const responder: ConversationResponder = {
            backend: "codex",
            async respond(input) {
                calls.push(input)
                if (input.requestId === "request-1") {
                    await firstGate.promise
                    return JSON.stringify({
                        schemaVersion: 1,
                        sessionId: input.sessionId,
                        requestId: input.requestId,
                        kind: "clarify",
                        message: "I need to know whether compatibility is required.",
                        questions: [{
                            id: "q-compat",
                            text: "Must the old API remain compatible?",
                        }],
                        goalEnvelope: null,
                    })
                }
                assert.match(input.userPrompt, /ASSISTANT \[request-1\]: I need to know/)
                assert.match(input.userPrompt, /Must the old API remain compatible\?/)
                assert.match(input.userPrompt, /USER \[request-2\]: Yes, preserve it/)
                return JSON.stringify(readyWire(input.sessionId, input.requestId))
            },
        }
        const intake = new ConversationIntake({
            sessionId: "session-ordered",
            responder,
        })

        const first = intake.submit({
            requestId: "request-1",
            text: "Refactor the API.",
        })
        const second = intake.submit({
            requestId: "request-2",
            text: "Yes, preserve it.",
        })
        await Promise.resolve()
        assert.equal(calls.length, 1)
        firstGate.resolve()

        assert.equal((await first).kind, "clarify")
        assert.equal((await second).kind, "ready")
        assert.equal(calls.length, 2)
    })

    it("deduplicates exact replay and rejects request-id content conflicts", async () => {
        let calls = 0
        const intake = new ConversationIntake({
            sessionId: "session-replay",
            responder: {
                backend: "claude",
                async respond(input) {
                    calls += 1
                    return JSON.stringify(readyWire(input.sessionId, input.requestId))
                },
            },
        })
        const request = { requestId: "request-1", text: "Implement the clear goal." }
        const [first, replay] = await Promise.all([
            intake.submit(request),
            intake.submit(request),
        ])
        assert.equal(first, replay)
        assert.equal(calls, 1)
        await assert.rejects(
            intake.submit({ ...request, text: "Different scope." }),
            /different content/,
        )
    })

    it("restores strict bounded durable history for a fresh per-turn process", async () => {
        const source = [
            { requestId: "request-1", role: "user" as const, text: "Refactor auth." },
            {
                requestId: "request-1",
                role: "assistant" as const,
                text: "Must the public API remain compatible?",
            },
        ]
        let prompt = ""
        const intake = new ConversationIntake({
            sessionId: "session-restored",
            historyLimit: 4,
            initialHistory: source,
            responder: {
                backend: "codex",
                async respond(input) {
                    prompt = input.userPrompt
                    return JSON.stringify(readyWire(input.sessionId, input.requestId))
                },
            },
        })
        // Caller mutation after construction cannot rewrite the restored copy.
        source[0]!.text = "attacker mutation"
        await intake.submit({
            requestId: "request-2",
            text: "Yes, preserve compatibility.",
            intent: "clarification",
        })
        assert.match(prompt, /USER \[request-1\]: Refactor auth\./)
        assert.doesNotMatch(prompt, /attacker mutation/)
        assert.match(prompt, /ALLOWED DISPOSITION: ready or clarify/)
        await assert.rejects(
            intake.submit({ requestId: "request-1", text: "Replay." }),
            /already exists in durable history/,
        )

        assert.throws(
            () => new ConversationIntake({
                sessionId: "session-invalid-history",
                responder: {
                    backend: "claude",
                    async respond() { return "{}" },
                },
                initialHistory: [source[0]!],
            }),
            /complete user\/assistant turn pairs/,
        )
    })

    it("tells chat turns they may answer or produce an explicit ready follow-up", async () => {
        let prompt = ""
        const intake = new ConversationIntake({
            sessionId: "session-chat",
            responder: {
                backend: "claude",
                async respond(input) {
                    prompt = input.userPrompt
                    return JSON.stringify({
                        schemaVersion: 1,
                        sessionId: input.sessionId,
                        requestId: input.requestId,
                        kind: "answer",
                        message: "The previous run completed successfully.",
                        questions: [],
                        goalEnvelope: null,
                    })
                },
            },
        })
        const result = await intake.submit({
            requestId: "request-status",
            text: "What happened?",
            intent: "chat",
        })
        assert.equal(result.kind, "answer")
        assert.match(prompt, /ready only for a clearly requested implementation follow-up/)
    })

    it("close aborts an active responder and rejects future turns", async () => {
        let aborted = false
        const intake = new ConversationIntake({
            sessionId: "session-close",
            responder: {
                backend: "claude",
                respond(_input, signal) {
                    return new Promise((_resolve, reject) => {
                        signal.addEventListener("abort", () => {
                            aborted = true
                            reject(new Error("aborted"))
                        }, { once: true })
                    })
                },
            },
        })
        const pending = intake.submit({ requestId: "request-1", text: "Hello." })
        await Promise.resolve()
        intake.close()
        await assert.rejects(pending, /aborted|closed/)
        assert.equal(aborted, true)
        await assert.rejects(
            intake.submit({ requestId: "request-2", text: "Again." }),
            /closed/,
        )
    })
})

function readyWire(sessionId: string, requestId: string) {
    return {
        schemaVersion: 1,
        sessionId,
        requestId,
        kind: "ready",
        message: "Clear. I am ready to hand this goal to planning.",
        questions: [],
        goalEnvelope: {
            objective: "Implement strict conversation-first goal intake.",
            constraints: ["Preserve downstream planning authority."],
            acceptanceCriteria: ["Clear goals produce a validated ready response."],
            nonGoals: [],
            assumptions: [],
        },
    }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}
