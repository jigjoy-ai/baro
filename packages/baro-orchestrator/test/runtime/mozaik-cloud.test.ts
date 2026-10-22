import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { AgenticEnvironment, BaseObserver, SemanticEvent } from "../../src/runtime/mozaik.js"
import { linkMozaikCloud } from "../../src/runtime/mozaik-cloud.js"

class Speaker extends BaseObserver {}

interface Shipped {
    url: string
    authorization: string | undefined
    events: Array<{ event: { type: string; payload: unknown } }>
}

function fakeIngest(): { fetch: typeof fetch; shipped: Shipped[] } {
    const shipped: Shipped[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        shipped.push({
            url,
            authorization: (init.headers as Record<string, string>).authorization,
            events: String(init.body).trim().split("\n").map((line) => JSON.parse(line)),
        })
        return new Response(JSON.stringify({}), { status: 202 })
    }) as unknown as typeof fetch
    return { fetch: fetchImpl, shipped }
}

describe("mozaik cloud exporter link", () => {
    it("stays off unless explicitly enabled", () => {
        const env = new AgenticEnvironment("cloud-off")
        const link = linkMozaikCloud(env, { env: { MOZAIK_API_KEY: "pk_test" }, log: () => {} })

        assert.equal(link, null)
        assert.equal(env.runtime.state.getParticipants().length, 0)
    })

    it("refuses to export without a key and says why", () => {
        const lines: string[] = []
        const link = linkMozaikCloud(new AgenticEnvironment("cloud-nokey"), {
            env: { BARO_MOZAIK_CLOUD: "1" },
            log: (line) => lines.push(line),
        })

        assert.equal(link, null)
        assert.match(lines.join("\n"), /MOZAIK_API_KEY is unset/)
    })

    it("joins the exporter as a runtime participant and ships bus traffic on end", async () => {
        const lines: string[] = []
        const ingest = fakeIngest()
        const env = new AgenticEnvironment("cloud-on")
        const speaker = new Speaker()
        speaker.join(env)

        const link = linkMozaikCloud(env, {
            env: {
                BARO_MOZAIK_CLOUD: "1",
                MOZAIK_API_KEY: "pk_test",
                MOZAIK_CLOUD_ENDPOINT: "https://cloud.test",
            },
            log: (line) => lines.push(line),
            fetch: ingest.fetch,
        })
        assert.ok(link)
        assert.deepEqual(
            env.runtime.state.getParticipants().map((p) => p.getManifest().name),
            ["Speaker", "mozaik-cloud-exporter"],
        )
        assert.match(lines.join("\n"), new RegExp(`watching live: .*${link.sessionId}`))

        env.deliverSemanticEvent(speaker, new SemanticEvent("story_result", { storyId: "S1" }))
        await link.end()

        assert.equal(env.runtime.state.getParticipants().length, 1)
        assert.ok(ingest.shipped.length > 0)
        assert.ok(ingest.shipped.every((batch) => batch.url === "https://cloud.test/v1/events"))
        assert.ok(ingest.shipped.every((batch) => batch.authorization === "Bearer pk_test"))
        const events = ingest.shipped.flatMap((batch) => batch.events.map((e) => e.event))
        assert.deepEqual(
            events.find((event) => event.type === "story_result")?.payload,
            { storyId: "S1" },
        )
        assert.ok(events.some((event) => event.type === "session.ended"))
    })

    it("never holds the run open on an unreachable cloud", async () => {
        const env = new AgenticEnvironment("cloud-hung")
        const link = linkMozaikCloud(env, {
            env: { BARO_MOZAIK_CLOUD: "1", MOZAIK_API_KEY: "pk_test" },
            log: () => {},
            fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
            endDeadlineMs: 50,
        })
        assert.ok(link)

        const started = Date.now()
        await link.end()

        assert.ok(Date.now() - started < 2_000)
        assert.equal(env.runtime.state.getParticipants().length, 0)
    })
})
