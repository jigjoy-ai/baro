import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { ConductorState } from "../../../src/semantic-events.js"
import type { BaroEvent } from "../../../src/tui-protocol.js"
import { ProgressForwarder } from "../../../src/participants/forwarders/progress.js"
import { captureStdout, source } from "../helpers.js"

describe("ProgressForwarder", () => {
    it("emits progress BaroEvents for running conductor levels", async () => {
        const forwarder = new ProgressForwarder()
        const lines = await captureStdout(async () => {
            await forwarder.onExternalEvent(
                source("conductor"),
                ConductorState.create({
                    phase: "running_level",
                    currentLevel: 3,
                    totalLevels: 5,
                }),
            )
        })

        const events = lines.map((line) => JSON.parse(line) as BaroEvent)
        assert.deepEqual(events, [
            { type: "progress", completed: 2, total: 5, percentage: 40 },
        ])
    })
})
