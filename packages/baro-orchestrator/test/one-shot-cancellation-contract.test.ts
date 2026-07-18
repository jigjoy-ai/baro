import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { runCodexOneShot } from "../src/codex-one-shot.js"
import { runOpenCodeOneShot } from "../src/opencode-one-shot.js"
import { runPiOneShot } from "../src/pi-one-shot.js"

describe("one-shot cancellation contract", () => {
    const lanes: ReadonlyArray<
        readonly [string, (signal: AbortSignal) => Promise<string>]
    > = [
        [
            "Codex",
            (signal) =>
                runCodexOneShot({
                    prompt: "must not launch",
                    cwd: process.cwd(),
                    signal,
                }),
        ],
        [
            "OpenCode",
            (signal) =>
                runOpenCodeOneShot({
                    prompt: "must not launch",
                    cwd: process.cwd(),
                    signal,
                }),
        ],
        [
            "Pi",
            (signal) =>
                runPiOneShot({
                    prompt: "must not launch",
                    cwd: process.cwd(),
                    signal,
                }),
        ],
    ]

    for (const [lane, run] of lanes) {
        it(`${lane} rejects an already-aborted caller signal as AbortError`, async () => {
            const controller = new AbortController()
            controller.abort()

            await assert.rejects(run(controller.signal), { name: "AbortError" })
        })
    }
})
