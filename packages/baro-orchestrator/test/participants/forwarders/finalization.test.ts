import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { FinalizeStarted, PrCreated } from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { FinalizationForwarder } from "../../../src/participants/forwarders/finalization.js"
import { captureStdout, source } from "../helpers.js"

describe("FinalizationForwarder", () => {
    it("emits finalization BaroEvents for start and PR creation", async () => {
        const forwarder = new FinalizationForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("finalizer"),
                FinalizeStarted.create({ branch: "feature/s9" }),
            )
            await forwarder.onExternalEvent(
                source("finalizer"),
                PrCreated.create({
                    url: "https://github.com/acme/baro/pull/9",
                    branch: "feature/s9",
                    baseBranch: "main",
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            { type: "finalize_start" },
            {
                type: "finalize_complete",
                pr_url: "https://github.com/acme/baro/pull/9",
            },
        ])
    })

    it("emits finalize_complete with null PR URL when no PR is created", async () => {
        const forwarder = new FinalizationForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("finalizer"),
                PrCreated.create({
                    url: null,
                    branch: "feature/s9",
                    baseBranch: "main",
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            {
                type: "finalize_complete",
                pr_url: null,
            },
        ])
    })

    it("accepts only the sealed collective Finalizer and denies an omitted one", async () => {
        const finalizer = source("finalizer")
        const forger = source("finalizer")
        const event = PrCreated.create({
            url: "https://github.com/acme/baro/pull/9",
            branch: "feature/s9",
            baseBranch: "main",
        })

        const bound = new FinalizationForwarder(true)
        const boundLines = await captureStdout(async () => {
            await bound.onExternalEvent(finalizer, event)
            bound.sealCollectiveAuthorities({ finalizer })
            await bound.onExternalEvent(forger, event)
            await bound.onExternalEvent(finalizer, event)
        })
        assert.deepEqual(
            boundLines.map((line) => JSON.parse(line) as BaroEvent),
            [{
                type: "finalize_complete",
                pr_url: "https://github.com/acme/baro/pull/9",
            }],
        )

        const disabled = new FinalizationForwarder(true)
        const disabledLines = await captureStdout(async () => {
            disabled.sealCollectiveAuthorities({})
            await disabled.onExternalEvent(forger, event)
        })
        assert.deepEqual(disabledLines, [])
    })
})
