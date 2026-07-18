import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { orchestrate } from "../src/orchestrate.js"

describe("collective Operator control boundary", () => {
    it("rejects direct abort/shutdown hooks before any run participant starts", async () => {
        await assert.rejects(
            orchestrate({
                prdPath: "/not-read/collective-operator-hooks.json",
                cwd: "/not-read",
                coordinationMode: "collective",
                operatorHooks: {
                    onAbort: () => undefined,
                },
            }),
            /control must cross a source-bound Mozaik semantic lane/,
        )
    })
})
