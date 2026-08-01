import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    AgenticEnvironment,
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
} from "../../src/runtime/mozaik.js"
import { StoryResult, WorkLeaseGranted } from "../../src/semantic-events.js"
import { AttemptRecallRunner } from "../../src/execution/attempt-recall-runner.js"
import {
    emptyAttempt,
    recallForRetry,
    withCommand,
    withStatement,
    withWrite,
    MAX_RECALLED_STATEMENTS,
} from "../../src/execution/attempt-recall.js"

class FakeAgent extends BaseObserver {
    constructor(readonly agentId: string) {
        super()
    }
}

class FakeBroker extends BaseObserver {}

describe("what a killed attempt hands to its successor", () => {
    it("says nothing when there is nothing to hand over", () => {
        assert.equal(recallForRetry(emptyAttempt()), null)
    })

    it("leads with the conclusion, not with the file list", () => {
        let record = emptyAttempt()
        record = withStatement(
            record,
            "`.default(x).optional()` gives both the optional output type and the runtime default.",
        )
        record = withWrite(record, "src/shops/dtos/searchShopQuery.dto.ts")
        const text = recallForRetry(record)
        assert.ok(text)
        assert.ok(
            text.indexOf(".default(x).optional()") <
                text.indexOf("searchShopQuery.dto.ts"),
            "the reasoning is what was lost; the files are on the branch",
        )
        assert.match(text, /was killed before it could report/u)
        assert.match(
            text,
            /not rejected/u,
            "a retry told it failed review would redo work nobody faulted",
        )
    })

    it("keeps the latest verdict for a command it ran twice", () => {
        let record = emptyAttempt()
        record = withCommand(record, "npx tsc --noEmit", true)
        record = withCommand(record, "npx tsc --noEmit", false)
        assert.deepEqual(record.commands, [
            { command: "npx tsc --noEmit", failed: false },
        ])
        const text = recallForRetry(record)
        assert.ok(text)
        assert.match(text, /✓ npx tsc --noEmit/u)
        assert.doesNotMatch(text, /✗ npx tsc --noEmit/u)
    })

    it("keeps the newest thinking when an attempt ran long", () => {
        let record = emptyAttempt()
        for (let index = 0; index < MAX_RECALLED_STATEMENTS + 4; index += 1) {
            record = withStatement(record, `conclusion ${index}`)
        }
        assert.equal(record.statements.length, MAX_RECALLED_STATEMENTS)
        assert.equal(record.statements.at(-1), `conclusion ${MAX_RECALLED_STATEMENTS + 3}`)
    })
})

describe("AttemptRecallRunner on the bus", () => {
    function harness() {
        const env = new AgenticEnvironment("attempt-recall")
        const broker = new FakeBroker()
        broker.join(env)
        const runner = new AttemptRecallRunner({
            runId: "run-1",
            leaseAuthority: broker,
            resolveRoot: () => "/var/wt/S2",
        })
        runner.join(env)

        const delivered: Array<{ recipientId: string; text: string }> = []
        const real = env.deliverSemanticEvent.bind(env)
        env.deliverSemanticEvent = (source, event) => {
            const data = (event as { data?: { recipientId?: string; text?: string } })
                .data
            if (data?.recipientId && data.text) {
                delivered.push({ recipientId: data.recipientId, text: data.text })
            }
            real(source, event)
        }
        return { env, broker, runner, delivered }
    }

    function killed(storyId: string) {
        return StoryResult.create({
            storyId,
            success: false,
            attempts: 1,
            durationSecs: 12,
            error: "worker was killed by SIGKILL before it reported",
            failure: { kind: "infrastructure", code: "process_killed" },
            runId: "run-1",
        })
    }

    function lease(storyId: string, generation: number) {
        return WorkLeaseGranted.create({
            runId: "run-1",
            offerId: `offer-${generation}`,
            leaseId: `lease-${generation}`,
            workerId: "worker",
            generation,
            request: { storyId, prompt: "migrate the DTOs", retries: 0, timeoutSecs: 60 },
        })
    }

    // The measured loss: S2 proved which zod form preserves an optional output
    // type by probing the compiler three times, was SIGKILLed, and derived it
    // again from nothing.
    it("gives the restarted story what the killed one worked out", () => {
        const { env, broker, delivered } = harness()
        const agent = new FakeAgent("S2")
        agent.join(env)

        env.deliverModelMessage(
            agent,
            ModelMessageItem.rehydrate({ text: "`.default(x).optional()` gives both the optional output type and the runtime default." }),
        )
        env.deliverFunctionCall(
            agent,
            FunctionCallItem.rehydrate({
                callId: "c1",
                name: "Bash",
                args: JSON.stringify({ command: "npx tsc --noEmit" }),
            }),
        )
        env.deliverFunctionCallOutput(
            agent,
            FunctionCallOutputItem.rehydrate({ callId: "c1", output: "TS OK" }),
        )
        env.deliverFunctionCall(
            agent,
            FunctionCallItem.rehydrate({
                callId: "c2",
                name: "Write",
                args: JSON.stringify({
                    file_path: "/private/var/wt/S2/src/shops/dtos/searchShopQuery.dto.ts",
                }),
            }),
        )

        env.deliverSemanticEvent(broker, killed("S2"))
        assert.equal(delivered.length, 0, "nothing is said until a successor exists")

        env.deliverSemanticEvent(broker, lease("S2", 2))

        assert.equal(delivered.length, 1)
        assert.equal(delivered[0]!.recipientId, "S2")
        const text = delivered[0]!.text
        assert.match(text, /\.default\(x\)\.optional\(\)/u)
        assert.match(text, /✓ npx tsc --noEmit/u)
        assert.match(
            text,
            /src\/shops\/dtos\/searchShopQuery\.dto\.ts/u,
            "the path must mean the same thing in the new worktree",
        )
        assert.doesNotMatch(text, /\/private|\/var\/wt/u)
    })

    it("hands it over once, not to every later lease", () => {
        const { env, broker, delivered } = harness()
        const agent = new FakeAgent("S2")
        agent.join(env)
        env.deliverModelMessage(
            agent,
            ModelMessageItem.rehydrate({ text: "the enum coerces on undefined" }),
        )
        env.deliverSemanticEvent(broker, killed("S2"))
        env.deliverSemanticEvent(broker, lease("S2", 2))
        env.deliverSemanticEvent(broker, lease("S2", 3))
        assert.equal(delivered.length, 1)
    })

    // A story that reported was judged on its work; its successor is answering
    // a review, not resuming an interrupted thought.
    it("stays quiet when the attempt actually reported", () => {
        const { env, broker, delivered } = harness()
        const agent = new FakeAgent("S3")
        agent.join(env)
        env.deliverModelMessage(
            agent,
            ModelMessageItem.rehydrate({ text: "done migrating" }),
        )
        env.deliverSemanticEvent(
            broker,
            StoryResult.create({
                storyId: "S3",
                success: false,
                attempts: 1,
                durationSecs: 30,
                error: "quality rejected",
                failure: { kind: "execution", code: "quality_rejected" },
                runId: "run-1",
            }),
        )
        env.deliverSemanticEvent(broker, lease("S3", 2))
        assert.equal(delivered.length, 0)
    })

    it("believes only the lease authority", () => {
        const { env, broker, delivered } = harness()
        const agent = new FakeAgent("S4")
        agent.join(env)
        env.deliverModelMessage(
            agent,
            ModelMessageItem.rehydrate({ text: "half-way through" }),
        )
        env.deliverSemanticEvent(broker, killed("S4"))

        const impostor = new FakeBroker()
        impostor.join(env)
        env.deliverSemanticEvent(impostor, lease("S4", 2))
        assert.equal(delivered.length, 0)

        env.deliverSemanticEvent(broker, lease("S4", 2))
        assert.equal(delivered.length, 1)
    })

    it("survives an item it cannot read", () => {
        const { env, broker, delivered } = harness()
        const agent = new FakeAgent("S5")
        agent.join(env)
        env.deliverFunctionCall(
            agent,
            FunctionCallItem.rehydrate({
                callId: "c9",
                name: "Bash",
                args: "{not json",
            }),
        )
        env.deliverModelMessage(
            agent,
            ModelMessageItem.rehydrate({ text: "still here" }),
        )
        env.deliverSemanticEvent(broker, killed("S5"))
        env.deliverSemanticEvent(broker, lease("S5", 2))
        assert.equal(delivered.length, 1)
        assert.match(delivered[0]!.text, /still here/u)
    })
})
