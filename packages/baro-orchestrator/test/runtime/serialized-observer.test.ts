import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { SemanticEvent } from "@mozaik-ai/core"

import {
    SerializedObserver,
    type SerializedEventContext,
    type SerializedObserverFailure,
    type SerializedObserverOptions,
} from "../../src/runtime/serialized-observer.js"
import { captureEnv, source } from "../participants/helpers.js"

type Handler = (
    context: SerializedEventContext,
) => Promise<void> | void

class ProbeObserver extends SerializedObserver {
    constructor(
        private readonly handler: Handler,
        options: SerializedObserverOptions = {},
    ) {
        super(options)
    }

    protected override handleEvent(
        context: SerializedEventContext,
    ): Promise<void> | void {
        return this.handler(context)
    }
}

class EventReportingObserver extends SerializedObserver {
    readonly handled: string[] = []

    protected override handleEvent(context: SerializedEventContext): void {
        const id = eventId(context)
        if (id === "explode") throw new Error("mailbox exploded")
        if (context.event.type === "managed_participant_failure") {
            this.handled.push(`failure:${context.internal}`)
        } else {
            this.handled.push(id)
        }
    }

    protected override onManagedFailure(
        failure: SerializedObserverFailure,
    ): void {
        this.publish(
            new SemanticEvent("managed_participant_failure", {
                kind: failure.kind,
                message: failure.error.message,
            }),
        )
    }
}

describe("SerializedObserver", () => {
    it("serializes asynchronous mailbox decisions in delivery order", async () => {
        const firstGate = deferred()
        const order: string[] = []
        let active = 0
        let maximumActive = 0

        const observer = new ProbeObserver(async (context) => {
            const id = eventId(context)
            order.push(`start:${id}`)
            active += 1
            maximumActive = Math.max(maximumActive, active)
            if (id === "first") await firstGate.promise
            active -= 1
            order.push(`end:${id}`)
        })
        const env = captureEnv()
        observer.join(env)

        env.deliverSemanticEvent(source("sender"), testEvent("first"))
        env.deliverSemanticEvent(source("sender"), testEvent("second"))

        await waitUntil(() => order.length === 1)
        assert.deepEqual(order, ["start:first"])

        firstGate.resolve()
        await observer.idle()

        assert.deepEqual(order, [
            "start:first",
            "end:first",
            "start:second",
            "end:second",
        ])
        assert.equal(maximumActive, 1)
    })

    it("reports a bad decision and continues processing its mailbox", async () => {
        const failures: SerializedObserverFailure[] = []
        const handled: string[] = []
        const observer = new ProbeObserver(
            (context) => {
                const id = eventId(context)
                if (id === "bad") throw "non-error failure"
                handled.push(id)
            },
            { onFailure: (failure) => failures.push(failure) },
        )
        const env = captureEnv()
        observer.join(env)

        const bad = testEvent("bad")
        env.deliverSemanticEvent(source("sender"), bad)
        env.deliverSemanticEvent(source("sender"), testEvent("good"))
        await observer.idle()

        assert.deepEqual(handled, ["good"])
        assert.equal(failures.length, 1)
        assert.equal(failures[0]?.kind, "mailbox")
        assert.equal(failures[0]?.cause, "non-error failure")
        assert.equal(failures[0]?.error.message, "non-error failure")
        assert.equal(failures[0]?.delivery?.event, bad)
    })

    it("serializes tasks by key while allowing different keys to overlap", async () => {
        const gates = new Map([
            ["A1", deferred()],
            ["A2", deferred()],
            ["B1", deferred()],
        ])
        const started: string[] = []
        const finished: string[] = []

        const observer = new ProbeObserver((context) => {
            const id = eventId(context)
            const key = id.startsWith("A") ? "A" : "B"
            context.spawnTask({ label: `task-${id}`, key }, async () => {
                started.push(id)
                await gates.get(id)!.promise
                finished.push(id)
            })
        })
        const env = captureEnv()
        observer.join(env)

        env.deliverSemanticEvent(source("sender"), testEvent("A1"))
        env.deliverSemanticEvent(source("sender"), testEvent("A2"))
        env.deliverSemanticEvent(source("sender"), testEvent("B1"))

        const idle = observer.idle()
        await waitUntil(() => started.includes("A1") && started.includes("B1"))
        assert.equal(started.includes("A2"), false)

        gates.get("B1")!.resolve()
        gates.get("A1")!.resolve()
        await waitUntil(() => started.includes("A2"))
        gates.get("A2")!.resolve()
        await idle

        assert.ok(started.indexOf("A1") < started.indexOf("A2"))
        assert.ok(finished.indexOf("A1") < finished.indexOf("A2"))
        assert.deepEqual(new Set(started), new Set(["A1", "A2", "B1"]))
    })

    it("contains task failures and lets the next task in the lane run", async () => {
        const failures: SerializedObserverFailure[] = []
        const ran: string[] = []
        const observer = new ProbeObserver(
            (context) => {
                const id = eventId(context)
                context.spawnTask({ label: id, key: "review:S1" }, async () => {
                    ran.push(id)
                    if (id === "bad-task") throw new Error("review failed")
                })
            },
            { onFailure: (failure) => failures.push(failure) },
        )
        const env = captureEnv()
        observer.join(env)

        const bad = testEvent("bad-task")
        env.deliverSemanticEvent(source("sender"), bad)
        env.deliverSemanticEvent(source("sender"), testEvent("next-task"))
        await observer.idle()

        assert.deepEqual(ran, ["bad-task", "next-task"])
        assert.equal(failures.length, 1)
        assert.equal(failures[0]?.kind, "task")
        assert.deepEqual(failures[0]?.task, {
            label: "bad-task",
            key: "review:S1",
        })
        assert.equal(failures[0]?.delivery?.event, bad)
        assert.equal(failures[0]?.error.message, "review failed")
    })

    it("idle waits for task-produced events and their mailbox decisions", async () => {
        const taskGate = deferred()
        const handled: Array<{ id: string; internal: boolean }> = []
        const observer = new ProbeObserver((context) => {
            const id = eventId(context)
            handled.push({ id, internal: context.internal })
            if (id === "start") {
                context.spawnTask({ label: "publish-follow-up" }, async () => {
                    await taskGate.promise
                    context.publish(testEvent("follow-up"))
                })
            }
        })
        const env = captureEnv()
        observer.join(env)

        env.deliverSemanticEvent(source("sender"), testEvent("start"))
        let settled = false
        const idle = observer.idle().then(() => {
            settled = true
        })

        await waitUntil(() => handled.length === 1)
        assert.equal(settled, false)
        taskGate.resolve()
        await idle

        assert.deepEqual(handled, [
            { id: "start", internal: false },
            { id: "follow-up", internal: true },
        ])
    })

    it("allows a failure hook to publish a generic event on the same bus", async () => {
        const observer = new EventReportingObserver()
        const env = captureEnv()
        observer.join(env)

        env.deliverSemanticEvent(source("sender"), testEvent("explode"))
        await observer.idle()

        assert.deepEqual(observer.handled, ["failure:true"])
        const report = env.events.find(
            (event) => event.type === "managed_participant_failure",
        )
        assert.ok(report)
        assert.deepEqual(report.data, {
            kind: "mailbox",
            message: "mailbox exploded",
        })
    })
})

function testEvent(id: string): SemanticEvent<{ id: string }> {
    return new SemanticEvent("runtime_test", { id })
}

function eventId(context: SerializedEventContext): string {
    return (context.event.data as { id?: string }).id ?? context.event.type
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return
        await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.fail("timed out waiting for condition")
}
