import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    FunctionCallItem,
    ModelContext,
    ModelMessageItem,
    type ContextItem,
    type GenerativeModel,
    type Tool,
} from "../../src/runtime/mozaik.js"
import { MozaikModelParticipant } from "../../src/harness/mozaik/model-participant.js"
import { AgentUserMessage } from "../../src/semantic-events.js"
import { joinWithCapture } from "./../execution/helpers.js"

/** A model that never speaks — every round is stubbed by the test. */
function silentModel(): GenerativeModel {
    return {
        specification: { name: "test-model" },
        setTools: () => {},
    } as unknown as GenerativeModel
}

function message(text: string): ModelMessageItem {
    return ModelMessageItem.rehydrate({ text })
}

function call(name: string, args: Record<string, unknown>): FunctionCallItem {
    return FunctionCallItem.rehydrate({
        callId: `call-${name}`,
        name,
        args: JSON.stringify(args),
    })
}

/**
 * Drive the loop offline. Each entry is one round's items; the recorded
 * contexts let a test assert what the model was actually shown.
 */
function stubRounds(
    participant: MozaikModelParticipant,
    rounds: ContextItem[][],
): ModelContext[] {
    const seen: ModelContext[] = []
    let index = 0
    Object.defineProperty(participant, "runRound", {
        value: async (context: ModelContext) => {
            seen.push(context)
            return { items: rounds[index++] ?? [] }
        },
    })
    return seen
}

function participant(options: Partial<{ tools: Tool[]; quietTimeoutMs: number }> = {}) {
    return new MozaikModelParticipant({
        agentId: "planner",
        model: silentModel(),
        systemPrompt: "you plan",
        quietTimeoutMs: options.quietTimeoutMs ?? 5,
        ...(options.tools ? { tools: options.tools } : {}),
    })
}

describe("a phase that stays open and listens", () => {
    it("answers, then settles with what it said", async () => {
        const p = participant()
        stubRounds(p, [[message("here is the plan")]])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("plan this goal")

        const summary = await p.done
        assert.equal(summary.lastMessage, "here is the plan")
        assert.deepEqual(summary.messages, ["here is the plan"])
        assert.equal(summary.rounds, 1)
    })

    it("reads what arrives mid-session and answers again", async () => {
        const p = participant()
        const seen = stubRounds(p, [
            [message("what do the scouts say?")],
            [message("revised with the finding")],
        ])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("plan this goal")

        // Arrives while the session is open — the seam stdin approximates.
        await new Promise((r) => setTimeout(r, 1))
        p.sendUserMessage("scout finding: the helper lives in src/common")

        const summary = await p.done
        assert.equal(summary.rounds, 2)
        assert.equal(summary.lastMessage, "revised with the finding")
        const shown = seen[1]!
            .getItems()
            .map((item) => JSON.stringify(item))
            .join(" ")
        assert.match(shown, /the helper lives in src\/common/)
    })

    it("puts every delivered message on the bus, so a run can narrate it", async () => {
        const p = participant()
        stubRounds(p, [[message("ok")]])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("first")
        await p.done

        const echoed = env.events
            .filter(AgentUserMessage.is)
            .map((event) => event.data.text)
        assert.deepEqual(echoed, ["first"])
    })
})

describe("tools are functions here, not a protocol", () => {
    it("calls the tool it was handed and feeds the result back", async () => {
        const seenArgs: unknown[] = []
        const publish: Tool = {
            type: "function",
            name: "publish_plan_fragment",
            description: "publish",
            parameters: { type: "object", properties: {} },
            invoke: async (args: unknown) => {
                seenArgs.push(args)
                return JSON.stringify({ admitted: ["S1"], graphVersion: 2 })
            },
        } as unknown as Tool

        const p = participant({ tools: [publish] })
        const seen = stubRounds(p, [
            [call("publish_plan_fragment", { stories: ["S1"] })],
            [message("fragment admitted")],
        ])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("plan")

        const summary = await p.done
        assert.deepEqual(seenArgs, [{ stories: ["S1"] }])
        assert.equal(summary.lastMessage, "fragment admitted")
        const fedBack = seen[1]!
            .getItems()
            .map((item) => JSON.stringify(item))
            .join(" ")
        assert.match(fedBack, /graphVersion/)
    })

    it("hands a named error back rather than dying on a bad tool", async () => {
        const p = participant({ tools: [] })
        const seen = stubRounds(p, [
            [call("nope", {})],
            [message("recovered")],
        ])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")

        await p.done
        const fedBack = seen[1]!
            .getItems()
            .map((item) => JSON.stringify(item))
            .join(" ")
        assert.match(fedBack, /tool 'nope' is not available/)
    })

    it("survives a throwing tool, reporting it as the tool's failure", async () => {
        const blowUp: Tool = {
            type: "function",
            name: "boom",
            description: "boom",
            parameters: { type: "object", properties: {} },
            invoke: async () => {
                throw new Error("relay unavailable")
            },
        } as unknown as Tool

        const p = participant({ tools: [blowUp] })
        const seen = stubRounds(p, [[call("boom", {})], [message("noted")]])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")

        await p.done
        const fedBack = seen[1]!
            .getItems()
            .map((item) => JSON.stringify(item))
            .join(" ")
        assert.match(fedBack, /Error running boom: relay unavailable/)
    })
})

// Both of these were found by a live run rather than by a test: the first
// took the phase down as an unhandled rejection, the second let a watchdog
// abort a session that was working.
describe("a session ends by reporting, never by throwing", () => {
    it("resolves with the failure when a round throws", async () => {
        const p = participant()
        Object.defineProperty(p, "runRound", {
            value: async () => {
                throw new Error("Request was aborted")
            },
        })
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")

        const summary = await p.done
        assert.equal(summary.error?.message, "Request was aborted")
        assert.match(p.sessionEndDetail(), /Request was aborted/u)
    })

    it("never rejects, because the sessions attach .then without .catch", async () => {
        const p = participant()
        Object.defineProperty(p, "runRound", {
            value: async () => {
                throw new Error("provider exploded")
            },
        })
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")

        let rejected = false
        // Exactly how the phases consume it — a rejection here is an
        // unhandled rejection that ends the process.
        void p.done.then(() => undefined, () => {
            rejected = true
        })
        await p.done
        assert.equal(rejected, false)
    })

    it("reports activity while a provider call is in flight", async () => {
        const p = participant()
        let beats = 0
        p.onActivity = () => {
            beats += 1
        }
        Object.defineProperty(p, "runRound", {
            // Longer than one heartbeat interval would be in a real run; the
            // test asserts the beat exists, not its period.
            value: async () => {
                await new Promise((r) => setTimeout(r, 20))
                return { items: [message("done")] }
            },
        })
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")
        await p.done
        assert.ok(beats > 0, "a call in flight must not look like silence")
    })
})

describe("the session ends when the caller says so, not on a stopwatch", () => {
    it("closes after input is closed", async () => {
        const p = participant({ quietTimeoutMs: 50 })
        stubRounds(p, [[message("done thinking")]])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")
        p.closeStdin()

        const summary = await p.done
        assert.equal(summary.rounds, 1)
    })

    it("reports activity so a watchdog measures silence, not duration", async () => {
        const p = participant()
        stubRounds(p, [[message("still here")]])
        let beats = 0
        p.onActivity = () => {
            beats += 1
        }
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")
        await p.done
        assert.ok(beats > 0, "a working session is never silent")
    })

    it("an abort settles rather than hanging the caller", async () => {
        const p = participant({ quietTimeoutMs: 10_000 })
        stubRounds(p, [[message("one")]])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")
        assert.equal(await p.abortAndWait(), true)
    })
})
