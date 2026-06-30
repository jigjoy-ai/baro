import { writeFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Finalizer } from "../../src/participants/finalizer.js"
import {
    PrCreated,
    RunCompleted,
    RunStarted,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("Finalizer", () => {
    it("emits a skipped PR result when the run did not succeed", async () => {
        await withTempDir("baro-finalizer-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    project: "Finalizer test",
                    branchName: "baro/finalizer-test",
                    description: "Exercise finalizer skip behavior",
                    userStories: [],
                }),
            )

            const logs: string[] = []
            const finalizer = new Finalizer({
                cwd: dir,
                prdPath,
                baseSha: "base-sha",
                onLog: (line) => logs.push(line),
            })
            const env = joinWithCapture(finalizer)

            await finalizer.onExternalEvent(
                source("conductor"),
                RunStarted.create({ project: "Finalizer test", storyCount: 1 }),
            )
            await finalizer.onExternalEvent(
                source("conductor"),
                RunCompleted.create({
                    success: false,
                    completedStories: [],
                    failedStories: ["S1"],
                    totalDurationSecs: 12,
                    totalAttempts: 2,
                    abortReason: "S1 failed",
                }),
            )
            await finalizer.complete()

            const event = env.events.find((e) => PrCreated.is(e))
            assert.ok(event, "PrCreated emitted for skipped PR")
            assert.deepEqual(event.data, {
                url: null,
                branch: "baro/finalizer-test",
                baseBranch: "",
            })
            assert.ok(
                logs.some((line) => line.includes("run did not complete successfully")),
                "skip reason logged",
            )
        })
    })
})
