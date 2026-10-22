import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { announceGates, SPAWN_GATES } from "../../src/execution/gate-registry.js"
import { storyWriteSurface, surfaceKey } from "../../src/execution/write-surface.js"
import type { PrdStory } from "../../src/prd.js"

function story(id: string, writes?: string[]): PrdStory {
    return {
        id,
        priority: 1,
        title: id,
        description: "",
        dependsOn: [],
        retries: 1,
        acceptance: [],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "standard",
        ...(writes ? { writes } : {}),
    } as PrdStory
}

describe("the write surface a story is dispatched with", () => {
    const owner = story("S1", ["src/menus/menu/menu.service.ts"])
    const peer = story("S2", ["src/shops/shops.service.ts"])

    it("names the story's own files and the owner of everyone else's", () => {
        const surface = storyWriteSurface(owner, [owner, peer])
        assert.ok(surface)
        assert.deepEqual(surface.writes, ["src/menus/menu/menu.service.ts"])
        assert.equal(surface.ownedElsewhere["src/shops/shops.service.ts"], "S2")
        assert.equal(
            surface.ownedElsewhere["src/menus/menu/menu.service.ts"],
            undefined,
            "a story is never a stranger in its own surface",
        )
    })

    it("names the regions and the peers of a file shared by region", () => {
        const a = story("S1", ["src/verify.ts#planDeclared", "src/a.ts"])
        const b = story("S2", ["src/verify.ts#resolveCwd"])
        const surface = storyWriteSurface(a, [a, b])
        assert.ok(surface)
        assert.deepEqual(surface.writes, ["src/verify.ts", "src/a.ts"])
        assert.deepEqual(surface.ownedElsewhere, {})
        assert.deepEqual(surface.regions, { "src/verify.ts": ["planDeclared"] })
        assert.deepEqual(surface.shared, { "src/verify.ts": ["S2"] })

        const prompt = announceGates(SPAWN_GATES, { surface }).join("\n")
        assert.match(prompt, /- src\/verify\.ts \(only: planDeclared\)/u)
        assert.match(prompt, /- src\/verify\.ts — also written by S2/u)
        assert.notEqual(
            surfaceKey(surface),
            surfaceKey({ writes: surface.writes, ownedElsewhere: {} }),
            "a changed sharing set is a revision worth announcing",
        )
    })

    it("does not call a dependency-ordered peer a co-writer", () => {
        const a = story("S1", ["src/verify.ts#planDeclared"])
        const b = { ...story("S2", ["src/verify.ts#resolveCwd"]), dependsOn: ["S1"] }
        const surface = storyWriteSurface(a, [a, b])
        assert.equal(surface?.shared, undefined)
    })

    it("adds no new keys for a story that declared plain paths", () => {
        assert.deepEqual(Object.keys(storyWriteSurface(owner, [owner, peer])!), [
            "writes",
            "ownedElsewhere",
        ])
    })

    it("leaves a story that declared nothing unbounded", () => {
        // Remediation work is created without writes. Handing it a surface of
        // pure prohibitions would refuse it every file it exists to repair.
        assert.equal(storyWriteSurface(story("GREM-1"), [owner, peer]), undefined)
    })

    /**
     * Source-order invariant, and it is here because breaking it costs runs
     * rather than a test: the boundary shipped once, wired into the only
     * dispatcher there was, and stayed behind when a second one became the
     * default. Two stories then lost a merge each to files they had no way to
     * know were owned, and nothing in the run said the word "surface".
     */
    it("is computed by every dispatcher that offers work", () => {
        for (const file of ["collective-board.ts", "conductor.ts"]) {
            const source = readFileSync(
                join(import.meta.dirname, "../../src/execution", file),
                "utf8",
            )
            assert.match(
                source,
                /storyWriteSurface\(/u,
                `${file} dispatches stories without computing a write surface`,
            )
        }
    })
})
