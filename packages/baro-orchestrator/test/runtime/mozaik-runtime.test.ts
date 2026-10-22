import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    AgenticEnvironment,
    BaroRuntimeState,
    BaseObserver,
    createHuman,
    ModelMessageItem,
    Participant,
    RuntimeEvent,
    SemanticEvent,
    SituationSpecification,
    type SituationContext,
} from "../../src/runtime/mozaik.js"
import { source } from "../execution/helpers.js"

class Recorder extends BaseObserver {
    constructor(readonly label: string, readonly log: string[]) {
        super()
    }

    override onJoined(): void {
        this.log.push(`${this.label}:joined`)
    }

    override onLeft(): void {
        this.log.push(`${this.label}:left`)
    }

    override onParticipantJoined(participant: Participant): void {
        this.log.push(`${this.label}:saw-join:${(participant as Recorder).label}`)
    }

    override onParticipantLeft(participant: Participant): void {
        this.log.push(`${this.label}:saw-leave:${(participant as Recorder).label}`)
    }

    override onInternalEvent(item: SemanticEvent<unknown>): void {
        this.log.push(`${this.label}:internal:${item.type}`)
    }

    override onExternalEvent(from: Participant, item: SemanticEvent<unknown>): void {
        const sender = from instanceof Recorder ? from.label : "outside"
        this.log.push(`${this.label}:external:${item.type}:from-${sender}`)
    }

    override onExternalModelMessage(_from: Participant, item: ModelMessageItem): void {
        this.log.push(`${this.label}:model:${item.content.text}`)
    }
}

class Picky extends Recorder {
    constructor(label: string, log: string[], hears: typeof Recorder) {
        super(label, log)
        this.listens = [hears]
    }
}

class Loud extends Recorder {}

class Everything extends SituationSpecification {
    isSatisfiedBy(_context: SituationContext): boolean {
        return true
    }
}

function ping(): SemanticEvent<{ n: number }> {
    return new SemanticEvent("ping", { n: 1 })
}

describe("baro bus on the Mozaik v4 runtime", () => {
    it("joins each participant as a runtime member with a manifest", () => {
        const env = new AgenticEnvironment("manifest")
        const a = new Recorder("a", [])
        a.join(env)

        assert.ok(env.runtime.state instanceof BaroRuntimeState)
        const [member] = env.runtime.state.getParticipants()
        assert.equal(member?.getManifest().name, "Recorder")
        assert.equal(member?.getManifest().role, "agent")
        assert.deepEqual(a.getEnvironments(), [env])

        a.leave(env)
        assert.equal(env.runtime.state.getParticipants().length, 0)
        assert.deepEqual(a.getEnvironments(), [])
    })

    it("keeps the v3 membership callbacks and their order", () => {
        const log: string[] = []
        const env = new AgenticEnvironment("membership")
        const a = new Recorder("a", log)
        const b = new Recorder("b", log)
        a.join(env)
        b.join(env)
        b.join(env)
        b.leave(env)

        assert.deepEqual(log, [
            "a:joined",
            "a:saw-join:b",
            "b:joined",
            "b:left",
            "a:saw-leave:b",
        ])
    })

    it("routes the producer to its internal hook and everyone else to the external one, in join order", () => {
        const log: string[] = []
        const env = new AgenticEnvironment("delivery")
        const a = new Recorder("a", log)
        const b = new Recorder("b", log)
        const c = new Recorder("c", log)
        for (const p of [a, b, c]) p.join(env)
        log.length = 0

        env.deliverSemanticEvent(b, ping())
        env.deliverSemanticEvent(source("S1"), ping())

        assert.deepEqual(log, [
            "a:external:ping:from-b",
            "b:internal:ping",
            "c:external:ping:from-b",
            "a:external:ping:from-outside",
            "b:external:ping:from-outside",
            "c:external:ping:from-outside",
        ])
    })

    it("honours listens filtering by source class", () => {
        const log: string[] = []
        const env = new AgenticEnvironment("listens")
        const picky = new Picky("picky", log, Loud)
        const quiet = new Recorder("quiet", log)
        const loud = new Loud("loud", log)
        for (const p of [picky, quiet, loud]) p.join(env)
        log.length = 0

        env.deliverSemanticEvent(quiet, ping())
        env.deliverSemanticEvent(loud, ping())

        assert.deepEqual(log, [
            "quiet:internal:ping",
            "loud:external:ping:from-quiet",
            "picky:external:ping:from-loud",
            "quiet:external:ping:from-loud",
            "loud:internal:ping",
        ])
    })

    it("lets a runtime-native participant observe baro traffic as Mozaik v4 events", () => {
        const env = new AgenticEnvironment("native")
        const speaker = new Recorder("speaker", [])
        speaker.join(env)
        const seen: RuntimeEvent[] = []
        const observer = createHuman({
            name: "observer",
            capabilities: [],
            handlers: [{
                specification: new Everything(),
                processor: { apply: ({ event }) => { seen.push(event) } },
            }],
        })
        env.admit(observer)

        env.deliverSemanticEvent(speaker, ping())
        env.deliverModelMessage(speaker, ModelMessageItem.rehydrate({ text: "done" }))

        const traffic = seen.filter((event) => event.type !== "participant.joined")
        assert.deepEqual(
            traffic.map((event) => [event.type, event.producerId]),
            [
                ["ping", env.runtime.state.getParticipants()[0]!.getId()],
                ["model.answer", env.runtime.state.getParticipants()[0]!.getId()],
            ],
        )
        assert.deepEqual(traffic[0]!.payload, { n: 1 })
        const { answer } = traffic[1]!.payload as { answer: ModelMessageItem }
        assert.equal(answer.content.text, "done")
    })

    it("never lets a failing runtime-native participant interrupt baro delivery", () => {
        const log: string[] = []
        const reports: string[] = []
        const env = new AgenticEnvironment("isolation")
        const broken = createHuman({
            name: "broken",
            capabilities: [],
            handlers: [{
                specification: new Everything(),
                processor: { apply: () => { throw new Error("boom") } },
            }],
        })
        const a = new Recorder("a", log)

        const write = process.stderr.write
        process.stderr.write = ((chunk: string) => {
            reports.push(chunk)
            return true
        }) as typeof process.stderr.write
        try {
            env.admit(broken)
            a.join(env)
            env.deliverSemanticEvent(source("S1"), ping())
        } finally {
            process.stderr.write = write
        }

        assert.deepEqual(log, ["a:joined", "a:external:ping:from-outside"])
        assert.equal(reports.length, 3)
        assert.match(reports[0]!, /runtime participant handler failed: boom/)
    })

    it("gives every environment its own runtime", () => {
        const first = new AgenticEnvironment("first")
        const second = new AgenticEnvironment("second")
        new Recorder("a", []).join(first)

        assert.notEqual(first.runtime, second.runtime)
        assert.equal(second.runtime.state.getParticipants().length, 0)
    })
})
