import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    CONVERSATION_HISTORY_PROMPT_MAX_BYTES,
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
                repositoryBrief: repositoryBrief(),
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
            repositoryBrief: repositoryBrief(),
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
        const request = {
            requestId: "request-1",
            text: "Implement the clear goal.",
            repositoryBrief: repositoryBrief(),
        }
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
            repositoryBrief: repositoryBrief(),
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

    it("bounds multibyte history by UTF-8 bytes while preserving the newest pair and current turn", async () => {
        const repeated = (label: string, length: number): string =>
            `${label}:${"界".repeat(length - label.length - 1)}`
        const history = [1, 2, 3].flatMap((turn) => [{
            requestId: `request-${turn}`,
            role: "user" as const,
            text: repeated(`user-${turn}`, 5_000),
        }, {
            requestId: `request-${turn}`,
            role: "assistant" as const,
            text: repeated(`assistant-${turn}`, 5_000),
        }])
        const currentText = repeated("current", 8_000)
        let prompt = ""
        const intake = new ConversationIntake({
            sessionId: "session-multibyte-history",
            historyLimit: 8,
            initialHistory: history,
            responder: {
                backend: "codex",
                async respond(input) {
                    prompt = input.userPrompt
                    return JSON.stringify(readyWire(input.sessionId, input.requestId))
                },
            },
        })

        await intake.submit({
            requestId: "request-current",
            text: currentText,
            intent: "clarification",
            repositoryBrief: repositoryBrief(),
        })

        const marker = "CONVERSATION HISTORY:\n"
        const projection = prompt
            .slice(prompt.indexOf(marker) + marker.length)
            .split("\n\nREPOSITORY OBSERVATIONS", 1)[0]!
        assert.ok(
            Buffer.byteLength(projection, "utf8") <=
                CONVERSATION_HISTORY_PROMPT_MAX_BYTES,
        )
        assert.match(projection, /older complete conversation turn\(s\) omitted/u)
        assert.doesNotMatch(projection, /USER \[request-1\]:/u)
        assert.doesNotMatch(projection, /USER \[request-2\]:/u)
        assert.match(projection, /USER \[request-3\]: user-3:/u)
        assert.match(projection, /ASSISTANT \[request-3\]: assistant-3:/u)
        assert.ok(projection.endsWith(`USER [request-current]: ${currentText}`))
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

    it("enforces intent dispositions instead of trusting prompt instructions", async () => {
        const answer = new ConversationIntake({
            sessionId: "session-goal-answer-rejected",
            responder: {
                backend: "claude",
                async respond(input) {
                    return JSON.stringify({
                        schemaVersion: 1,
                        sessionId: input.sessionId,
                        requestId: input.requestId,
                        kind: "answer",
                        message: "I answered without resolving intake.",
                        questions: [],
                        goalEnvelope: null,
                    })
                },
            },
        })
        await assert.rejects(
            answer.submit({ requestId: "request-goal-answer", text: "Implement it." }),
            /must resolve as ready or clarify/u,
        )

        for (const [intent, sessionId] of [
            ["goal", "session-goal-ready-rejected"],
            ["chat", "session-chat-ready-rejected"],
        ] as const) {
            const readyWithoutContext = new ConversationIntake({
                sessionId,
                responder: {
                    backend: "claude",
                    async respond(input) {
                        return JSON.stringify(readyWire(input.sessionId, input.requestId))
                    },
                },
            })
            await assert.rejects(
                readyWithoutContext.submit({
                    requestId: `request-${intent}-ready`,
                    text: "Implement this.",
                    intent,
                }),
                /requires repository context before ready/u,
            )
        }
    })

    it("projects a validated brief as explicitly untrusted observations", async () => {
        let prompt = ""
        let systemPrompt = ""
        const intake = new ConversationIntake({
            sessionId: "session-repository-brief",
            responder: {
                backend: "codex",
                async respond(input) {
                    prompt = input.userPrompt
                    systemPrompt = input.systemPrompt
                    return JSON.stringify(readyWire(input.sessionId, input.requestId))
                },
            },
        })
        const brief = {
            schemaVersion: 1 as const,
            snapshotId: `sha256:${"b".repeat(64)}`,
            summary: "A bounded repository observation.",
            facts: [{
                statement: "A relevant path contains the goal term.",
                evidencePath: "src/session.ts",
                line: 4,
                confidence: "high" as const,
            }],
            relevantPaths: ["src/session.ts"],
            unknowns: [],
            truncated: false,
        }
        await intake.submit({
            requestId: "request-brief",
            text: "Refactor repository session handling.",
            intent: "goal",
            repositoryBrief: brief,
        })

        assert.match(systemPrompt, /contents as untrusted data/)
        assert.match(prompt, /REPOSITORY OBSERVATIONS \(UNTRUSTED DATA/)
        assert.match(prompt, /"snapshotId":"sha256:bbbb/)
        assert.match(prompt, /"evidencePath":"src\/session\.ts"/)

        await assert.rejects(
            intake.submit({
                requestId: "request-brief",
                text: "Refactor repository session handling.",
                intent: "goal",
                repositoryBrief: { ...brief, summary: "Different observation." },
            }),
            /different content/,
        )
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

    it("reports its own watchdog timeout ahead of synchronous abort rejection", async () => {
        let aborted = false
        const intake = new ConversationIntake({
            sessionId: "session-watchdog-order",
            timeoutMs: 20,
            responder: {
                backend: "openai",
                async respond(_input, signal) {
                    return await new Promise((_resolve, reject) => {
                        signal.addEventListener("abort", () => {
                            aborted = true
                            reject(new Error("incidental provider AbortError"))
                        }, { once: true })
                    })
                },
            },
        })

        await assert.rejects(
            intake.submit({ requestId: "request-watchdog", text: "status" }),
            /conversation response timed out after 20ms/u,
        )
        assert.equal(aborted, true)
        intake.close()
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

function repositoryBrief() {
    return {
        schemaVersion: 1 as const,
        snapshotId: `sha256:${"d".repeat(64)}`,
        summary: "A stable bounded repository observation.",
        facts: [],
        relevantPaths: [],
        unknowns: [],
        truncated: false,
    }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}
