import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import {
    buildFinalPrdRepairMessage,
    buildWriteSurfaceOverlapRemedySection,
} from "../../src/planning/domain/planner-prompts.js"
import type { WriteSurfaceOverlapFacts } from "../../src/events/runtime-graph.js"

const BUS_SESSION = new URL(
    "../../src/planning/adapters/planner-bus-session.ts",
    import.meta.url,
)

const twoOwners: WriteSurfaceOverlapFacts = {
    candidateStoryId: "S4",
    owners: [
        {
            storyId: "S2",
            ownedFiles: ["src/alpha.ts", "src/two.ts"],
            collidingPaths: ["src/two.ts"],
        },
        {
            storyId: "S3",
            ownedFiles: ["src/three.ts"],
            collidingPaths: ["src/three.ts"],
        },
    ],
    remainingPaths: ["src/four.ts"],
}

const noRemainder: WriteSurfaceOverlapFacts = {
    candidateStoryId: "S4",
    owners: [
        {
            storyId: "S2",
            ownedFiles: ["src/two.ts"],
            collidingPaths: ["src/two.ts"],
        },
    ],
    remainingPaths: [],
}

describe("write-surface overlap remedy section", () => {
    it("names every colliding owner and the three remedies", () => {
        const section = buildWriteSurfaceOverlapRemedySection(twoOwners)

        assert.equal(
            section,
            "Write-surface overlap (2):\n" +
                "- story 'S2' owns: src/alpha.ts, src/two.ts; collides on: src/two.ts\n" +
                "- story 'S3' owns: src/three.ts; collides on: src/three.ts\n" +
                "Remedies (pick one):\n" +
                "1. Drop the overlapping file(s) from this story and keep only " +
                "the files still available to it: src/four.ts\n" +
                "2. Drop this story entirely if its purpose is already covered " +
                "by a settled story's merged output.\n" +
                "3. Re-scope this story onto files no settled story owns.",
        )
    })

    it("says no files remain when every candidate path collides", () => {
        const section = buildWriteSurfaceOverlapRemedySection(noRemainder)

        assert.ok(
            section.includes(
                "1. Drop the overlapping file(s) from this story and keep only " +
                    "the files still available to it: no files remain available " +
                    "to this story",
            ),
        )
        assert.ok(
            section.includes(
                "2. Drop this story entirely if its purpose is already covered " +
                    "by a settled story's merged output.",
            ),
        )
        assert.ok(
            section.includes(
                "3. Re-scope this story onto files no settled story owns.",
            ),
        )
    })
})

describe("final PRD repair message with overlap facts", () => {
    it("inserts the remedy section after the defects and before the obligations", () => {
        const message = buildFinalPrdRepairMessage({
            reason: "overlapping write surface",
            unownedObligationIds: ["O-007"],
            writeSurfaceOverlap: twoOwners,
        })

        const defects = message.indexOf("Defects (")
        const overlap = message.indexOf("Write-surface overlap (")
        const obligations = message.indexOf("Unowned architecture obligations (")
        assert.ok(defects >= 0 && overlap >= 0 && obligations >= 0)
        assert.ok(defects < overlap && overlap < obligations)
        assert.ok(
            message.includes(
                `\n\n${buildWriteSurfaceOverlapRemedySection(twoOwners)}\n\n`,
            ),
        )
    })

    it("is byte-identical to the un-enriched message when no facts are carried", () => {
        const input = {
            reason: "planner was not initialized by the harness",
            unownedObligationIds: ["O-007"],
        }

        assert.equal(
            buildFinalPrdRepairMessage({
                ...input,
                writeSurfaceOverlap: undefined,
            }),
            buildFinalPrdRepairMessage(input),
        )
        assert.ok(
            !buildFinalPrdRepairMessage(input).includes(
                "Write-surface overlap (",
            ),
        )
    })
})

describe("both planner retry surfaces share one remedy renderer", () => {
    it("composes the fragment tool error from the same section", async () => {
        const source = await readFile(BUS_SESSION, "utf8")

        assert.match(
            source,
            /\$\{base\}\\n\\n\$\{buildWriteSurfaceOverlapRemedySection\(outcome\.overlap\)\}/u,
        )
        assert.equal(
            source.match(/buildWriteSurfaceOverlapRemedySection/gu)?.length,
            2,
            "one import, one call site — no second remedy dialect",
        )
    })
})
