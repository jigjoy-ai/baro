import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "@rstest/core"

import {
    decidePathClaim,
    storyWriteSurface,
} from "../../src/execution/write-surface.js"
import {
    materializeStoryHooks,
    refreshStoryHookSurface,
} from "../../src/harness/claude/hook-bridge.js"
import type { PrdStory } from "../../src/prd.js"

function story(id: string, writes: string[], passes = false): PrdStory {
    return {
        id,
        priority: 1,
        title: id,
        description: `Implement ${id}.`,
        dependsOn: [],
        retries: 1,
        acceptance: [`${id} works`],
        tests: [],
        passes,
        completedAt: null,
        durationSecs: null,
        model: "standard",
        writes,
    } as PrdStory
}

describe("runtime path claims", () => {
    // The hermes-baro run: S5 needed a file of S3, which had integrated, and
    // S6 one of S1. Both were free, yet each cost a failed attempt and a
    // one-line remediation story.
    it("grants a path its integrated owner released, naming who released it", () => {
        const s3 = story("S3", ["tests/test_tools.py"], true)
        const s5 = story("S5", ["tools.py"])
        assert.deepEqual(
            decidePathClaim("S5", "tests/test_tools.py", [s3, s5], new Map()),
            { path: "tests/test_tools.py", outcome: "granted", releasedBy: "S3" },
        )
    })

    it("grants a path nobody declared", () => {
        const s5 = story("S5", ["tools.py"])
        assert.deepEqual(
            decidePathClaim("S5", "README.md", [s5], new Map()),
            { path: "README.md", outcome: "granted" },
        )
    })

    it("keeps a path with the running story that declared it", () => {
        const s3 = story("S3", ["tests/test_tools.py"])
        const s5 = story("S5", ["tools.py"])
        assert.deepEqual(
            decidePathClaim("S5", "tests/test_tools.py", [s3, s5], new Map()),
            { path: "tests/test_tools.py", outcome: "held", ownerStoryId: "S3" },
        )
    })

    it("keeps a path with the running story that claimed it first", () => {
        const s5 = story("S5", ["tools.py"])
        const s6 = story("S6", ["bridge.py"])
        const claims = new Map([["__init__.py", "S5"]])
        assert.deepEqual(
            decidePathClaim("S6", "__init__.py", [s5, s6], claims),
            { path: "__init__.py", outcome: "held", ownerStoryId: "S5" },
        )
    })

    it("frees a claim once its claimant integrates", () => {
        const s5 = story("S5", ["tools.py"], true)
        const s6 = story("S6", ["bridge.py"])
        const claims = new Map([["__init__.py", "S5"]])
        assert.equal(
            decidePathClaim("S6", "__init__.py", [s5, s6], claims).outcome,
            "granted",
        )
    })

    it("reports a declared or already-claimed path as the claimant's own", () => {
        const s5 = story("S5", ["tools.py"])
        const claims = new Map([["README.md", "S5"]])
        assert.equal(decidePathClaim("S5", "tools.py", [s5], claims).outcome, "already_owned")
        assert.equal(decidePathClaim("S5", "README.md", [s5], claims).outcome, "already_owned")
    })

    it("puts a claim in the claimant's surface and in every running peer's ownedElsewhere", () => {
        const s5 = story("S5", ["tools.py"])
        const s6 = story("S6", ["bridge.py"])
        const claims = new Map([["tests/test_tools.py", "S5"]])
        assert.deepEqual(
            storyWriteSurface(s5, [s5, s6], claims)?.writes.sort(),
            ["tests/test_tools.py", "tools.py"],
        )
        assert.equal(
            storyWriteSurface(s6, [s5, s6], claims)?.ownedElsewhere["tests/test_tools.py"],
            "S5",
        )
        const integrated = story("S5", ["tools.py"], true)
        assert.equal(
            storyWriteSurface(s6, [integrated, s6], claims)?.ownedElsewhere["tests/test_tools.py"],
            undefined,
        )
    })

    it("gives a story that declared nothing a surface made of its claims", () => {
        const fix = story("FIX", [])
        assert.equal(storyWriteSurface(fix, [fix]), undefined)
        assert.deepEqual(
            storyWriteSurface(fix, [fix], new Map([["src/a.ts", "FIX"]]))?.writes,
            ["src/a.ts"],
        )
    })
})

describe("a Claude story's write hook follows surface revisions", () => {
    const collab = { command: "agent-collab", capability: "note" }

    it("stops refusing a path once the revision releases it", () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-hook-follow-"))
        try {
            materializeStoryHooks(
                dir,
                { writes: ["tools.py"], ownedElsewhere: { "tests/test_tools.py": "S3" } },
                collab,
                dir,
            )
            const write = () =>
                execFileSync("node", [join(dir, "hook.mjs"), "pre-write"], {
                    input: JSON.stringify({ tool_input: { file_path: "tests/test_tools.py" }, cwd: dir }),
                    encoding: "utf8",
                })
            assert.match(write(), /"decision":"block"/)

            refreshStoryHookSurface(
                dir,
                { writes: ["tools.py", "tests/test_tools.py"], ownedElsewhere: {} },
                collab,
            )

            assert.equal(write(), "")
            const surface = JSON.parse(readFileSync(join(dir, "surface.json"), "utf8"))
            assert.deepEqual(surface.writes, ["tools.py", "tests/test_tools.py"])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("installs nothing for a story whose hook never guarded writes", () => {
        const dir = mkdtempSync(join(tmpdir(), "baro-hook-follow-"))
        try {
            refreshStoryHookSurface(dir, { writes: ["a.ts"], ownedElsewhere: {} }, collab)
            assert.throws(() => readFileSync(join(dir, "surface.json"), "utf8"))
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
