import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { descendantsFromParentPairs } from "../src/process-tree.js"

describe("process-tree discovery", () => {
    it("walks a parent table without including unrelated processes", () => {
        assert.deepEqual(
            descendantsFromParentPairs(10, [
                [11, 10],
                [12, 10],
                [13, 11],
                [99, 1],
            ]),
            [11, 12, 13],
        )
    })

    it("deduplicates malformed parent-table cycles", () => {
        assert.deepEqual(
            descendantsFromParentPairs(20, [
                [21, 20],
                [22, 21],
                [21, 22],
            ]),
            [21, 22],
        )
    })
})
