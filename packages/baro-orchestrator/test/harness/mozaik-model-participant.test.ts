import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    BaseObserver,
    FunctionCallItem,
    ModelContext,
    ModelMessageItem,
    type ContextItem,
    type GenerativeModel,
    type Tool,
} from "../../src/runtime/mozaik.js"
import { MozaikModelParticipant } from "../../src/harness/mozaik/model-participant.js"
import {
    AgentResult,
    AgentTargetedMessage,
    AgentUserMessage,
} from "../../src/semantic-events.js"
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

// Found by a live run, not by a test: the DeepSeek Architect sat with its
// connection open and no round ever came back to the session. Every session
// built on this port — the Architect's ReplyStream, the planner's ResultStream,
// the research board — settles on AgentResult, which the CLI lane got for free
// from Claude's `result` frame. A lane that never publishes one looks alive and
// says nothing, until the idle watchdog ends the phase.
describe("a finished turn is something the sessions can hear", () => {
    it("publishes the turn's reply as the terminal event", async () => {
        const p = participant()
        stubRounds(p, [[message("here is the plan")]])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("plan this goal")
        await p.done

        const results = env.events.filter(AgentResult.is)
        assert.deepEqual(
            results.map((event) => event.data.resultText),
            ["here is the plan"],
        )
        assert.equal(results[0]!.data.agentId, "planner")
        assert.equal(results[0]!.data.isError, false)
    })

    it("stays silent mid-turn, while the model is still calling tools", async () => {
        const publish: Tool = {
            type: "function",
            name: "publish_plan_fragment",
            description: "publish",
            parameters: { type: "object", properties: {} },
            invoke: async () => "{}",
        } as unknown as Tool

        const p = participant({ tools: [publish] })
        stubRounds(p, [
            [message("publishing S1 now"), call("publish_plan_fragment", {})],
            [message("fragment admitted")],
        ])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("plan")
        await p.done

        // One turn, one terminal: a session that heard the mid-turn text would
        // treat "publishing S1 now" as the plan.
        assert.deepEqual(
            env.events.filter(AgentResult.is).map((event) => event.data.resultText),
            ["fragment admitted"],
        )
    })

    it("carries the turn's token usage, which every cost figure is built on", async () => {
        const p = participant()
        let index = 0
        Object.defineProperty(p, "runRound", {
            value: async () => ({
                items: [message(`round ${++index}`)],
                usage: {
                    inputTokens: 1_000,
                    outputTokens: 40,
                    totalTokens: 1_040,
                    inputTokenDetails: { cached_tokens: 600 },
                    outputTokenDetails: { reasoning_tokens: 12 },
                },
            }),
        })
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")
        await p.done

        const usage = env.events.filter(AgentResult.is)[0]!.data.usage
        assert.deepEqual(usage, {
            input_tokens: 1_000,
            output_tokens: 40,
            total_tokens: 1_040,
            cached_input_tokens: 600,
            reasoning_tokens: 12,
            rounds: 1,
        })
    })
})

// The research board addresses a peer's finding to a scout still reading, and
// the CLI lane forwards it to stdin. A native scout that never listened lost
// horizontal awareness silently: it still answered, only alone.
describe("a peer's finding reaches a session that is still reading", () => {
    const note = (recipientId: string, correlated: boolean) =>
        AgentTargetedMessage.create({
            recipientId,
            text: "[peer Q2] transactions use dataSource.transaction (src/db.ts:12)",
            metadata: { source: "research-board" },
            ...(correlated
                ? { runId: "research:s1", leaseId: "scout:s1:Q1", generation: 0 }
                : {}),
        })

    function scout(authority: BaseObserver) {
        return new MozaikModelParticipant({
            agentId: "scout:s1:Q1",
            model: silentModel(),
            systemPrompt: "you scout",
            targetedMessageAuthority: authority,
            targetedMessageCorrelation: {
                runId: "research:s1",
                leaseId: "scout:s1:Q1",
                generation: 0,
            },
        })
    }

    it("hands it to the model as something to read", async () => {
        const board = new (class extends BaseObserver {})()
        const p = scout(board)
        const seen = stubRounds(p, [[message("answer one")], [message("answer two")]])
        const env = joinWithCapture(p)
        board.join(env)
        p.start(env)
        p.sendUserMessage("Which module owns menu visibility?")

        await new Promise((r) => setTimeout(r, 5))
        env.deliverSemanticEvent(board, note("scout:s1:Q1", true))
        p.closeStdin()

        const summary = await p.done
        assert.equal(summary.rounds, 2)
        assert.match(
            JSON.stringify(seen[1]!.getItems()),
            /dataSource.transaction/u,
        )
    })

    it("ignores a note from anyone but its own board", async () => {
        const board = new (class extends BaseObserver {})()
        const impostor = new (class extends BaseObserver {})()
        const p = scout(board)
        stubRounds(p, [[message("answer one")]])
        const env = joinWithCapture(p)
        board.join(env)
        impostor.join(env)
        p.start(env)
        p.sendUserMessage("Which module owns menu visibility?")

        await new Promise((r) => setTimeout(r, 5))
        env.deliverSemanticEvent(impostor, note("scout:s1:Q1", true))
        env.deliverSemanticEvent(board, note("scout:s1:Q2", true))
        p.closeStdin()

        const summary = await p.done
        assert.equal(summary.rounds, 1, "neither note was for this session to read")
    })
})

// A phase on this lane spends real money with nothing between it and the
// endpoint: no CLI wrapper reports what it cost, so the gateway's own
// correlation is the only record there will ever be.
describe("a native phase's rounds are billed like any other", () => {
    it("correlates each round to its phase, turn and round", async () => {
        const dispatched: Array<Record<string, unknown>> = []
        const coordinator = {
            prepareDispatch: (
                _baseUrl: string | undefined,
                _apiKey: string | undefined,
                context: Record<string, unknown>,
            ) => {
                dispatched.push(context)
                return null // untrusted endpoint: nothing to bill, nothing to send
            },
        }

        const p = new MozaikModelParticipant({
            agentId: "architect",
            model: silentModel(),
            systemPrompt: "you decide",
            quietTimeoutMs: 5,
            billing: {
                coordinator: coordinator as never,
                phase: "architect",
            },
        })
        // The real round runs: only the endpoint is absent, so the call fails
        // after the dispatch we are asserting on.
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("design this")
        await p.done

        assert.equal(dispatched.length, 1)
        assert.equal(dispatched[0]!.phase, "architect")
        assert.equal(dispatched[0]!.turn, 1)
        assert.equal(dispatched[0]!.round, 1)
        assert.equal(dispatched[0]!.storyId, null)
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
// The failure this pins: the Architect declared itself finished and exited
// while its scouts were still reading the repository, because waiting had a
// two-second deadline. Waiting is not idleness when the next message depends
// on other agents finishing work.
describe("waiting for the caller is not idleness", () => {
    it("stays open past any quiet stretch until input is closed", async () => {
        const p = new MozaikModelParticipant({
            agentId: "architect",
            model: silentModel(),
            systemPrompt: "you decide",
        })
        const seen = stubRounds(p, [
            [message("what do the scouts say?")],
            [message("decided")],
        ])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("design this")

        // Longer than the old two-second deadline: research takes minutes.
        await new Promise((r) => setTimeout(r, 60))
        assert.equal(seen.length, 1, "still open, still waiting for findings")

        p.sendUserMessage("scout finding: transactions use dataSource.transaction")
        p.closeStdin()

        const summary = await p.done
        assert.equal(summary.rounds, 2)
        assert.equal(summary.lastMessage, "decided")
    })

    it("honours an explicit quiet deadline when a caller asks for one", async () => {
        const p = new MozaikModelParticipant({
            agentId: "probe",
            model: silentModel(),
            systemPrompt: "brief",
            quietTimeoutMs: 5,
        })
        stubRounds(p, [[message("done")]])
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")
        const summary = await p.done
        assert.equal(summary.rounds, 1)
    })
})

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

// The failure that ended the first jigjoy run: round ten of the Architect's
// research dropped its connection, and the phase restarted from an empty
// context — ten rounds and their tokens spent twice, then abandoned. A CLI
// lane never shows this because its client retries inside itself.
describe("a dropped connection costs the round, not the phase", () => {
    it("re-issues the call and keeps the context it had", async () => {
        const p = participant()
        let attempts = 0
        const seen: ModelContext[] = []
        Object.defineProperty(p, "runRound", {
            value: async (context: ModelContext) => {
                seen.push(context)
                attempts += 1
                if (attempts === 1) throw new Error("Connection error.")
                return { items: [message("answered on the retry")] }
            },
        })
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")

        const summary = await p.done
        assert.equal(attempts, 2)
        assert.equal(summary.error, null)
        assert.equal(summary.lastMessage, "answered on the retry")
        // Same context both times: a retry resumes the conversation, it does
        // not restart it.
        assert.deepEqual(
            JSON.stringify(seen[0]!.getItems()),
            JSON.stringify(seen[1]!.getItems()),
        )
    })

    it("gives up on a failure that is not transport", async () => {
        const p = participant()
        let attempts = 0
        Object.defineProperty(p, "runRound", {
            value: async () => {
                attempts += 1
                throw new Error("model does not implement tool calling")
            },
        })
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")
        await p.done
        assert.equal(attempts, 1, "a deterministic failure repeats deterministically")
    })
})

describe("a round that never answers is ended by its own deadline", () => {
    it("stops a hung call instead of waiting forever behind a heartbeat", async () => {
        const p = new MozaikModelParticipant({
            agentId: "architect",
            model: silentModel(),
            systemPrompt: "you decide",
            quietTimeoutMs: 5,
            perRoundTimeoutSecs: 0.05,
        })
        Object.defineProperty(p, "runRound", {
            // A call that never answers, exactly like the live one that held a
            // connection open for seventeen minutes.
            value: () => new Promise(() => {}),
        })
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")

        const summary = await p.done
        assert.match(
            summary.error?.message ?? "",
            /timed out after 50ms/u,
            "the round must end on its own deadline",
        )
    })

    it("reports a deadline as a timeout, not as cancellation", async () => {
        const p = new MozaikModelParticipant({
            agentId: "architect",
            model: silentModel(),
            systemPrompt: "you decide",
            quietTimeoutMs: 5,
            perRoundTimeoutSecs: 0.05,
        })
        Object.defineProperty(p, "runRound", {
            value: () => new Promise(() => {}),
        })
        const env = joinWithCapture(p)
        p.start(env)
        p.sendUserMessage("go")
        await p.done
        // Telemetry and billing distinguish the two; a timeout dressed as a
        // cancellation would be attributed to shutdown.
        assert.equal(p.sessionEndDetail().includes("aborted"), false)
        assert.match(p.sessionEndDetail(), /timed out/u)
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
