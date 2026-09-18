import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Sentry } from "../../src/execution/sentry.js"
import {
    isActiveOwner,
    storyWriteSurface,
    surfacesOverlap,
} from "../../src/execution/write-surface.js"
import { createStoryTools } from "../../src/planning/adapters/story-tools.js"
import type { PrdFile, PrdStory } from "../../src/prd.js"
import { FunctionCallItem } from "../../src/runtime/mozaik.js"
import { validateRuntimeReplanMutation } from "../../src/runtime/runtime-replan.js"
import {
    Coordination,
    StoryMerged,
    StorySpawnRequest,
} from "../../src/semantic-events.js"
import { joinWithCapture, source } from "./helpers.js"

const F = "src/shared/feature.ts"

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

function prd(stories: PrdStory[]): PrdFile {
    return {
        project: "release",
        branchName: "baro/release",
        description: "write-surface release",
        userStories: stories,
    }
}

function addB(writes: string[]) {
    return {
        addedStories: [
            {
                id: "B",
                priority: 10,
                title: "B",
                description: "Implement B.",
                dependsOn: [],
                retries: 1,
                acceptance: ["B works"],
                tests: ["npm test"],
                model: "standard",
                writes,
            },
        ],
        removedStoryIds: [],
        modifiedDeps: {},
    }
}

async function writeWith(
    surface: ReturnType<typeof storyWriteSurface>,
    path: string,
): Promise<{ result: string; written: boolean }> {
    const cwd = mkdtempSync(join(tmpdir(), "write-surface-release-"))
    try {
        const tool = createStoryTools(cwd, { surface }).find(
            (candidate) => candidate.name === "write_file",
        ) as unknown as {
            invoke(args: { path: string; content: string }): Promise<string>
        }
        const result = await tool.invoke({ path, content: "x" })
        return { result, written: existsSync(join(cwd, path)) }
    } finally {
        rmSync(cwd, { recursive: true, force: true })
    }
}

describe("write-surface ownership is released when a story integrates", () => {
    it("a merged owner no longer owns F, so B's write to F passes the gate", async () => {
        const a = story("A", [F], true)
        const b = story("B", [F, "src/b.ts"])
        assert.equal(isActiveOwner(a), false)

        const surface = storyWriteSurface(b, [a, b])
        assert.ok(surface)
        assert.equal(surface.ownedElsewhere[F], undefined)

        const { result, written } = await writeWith(surface, F)
        assert.match(result, /^Wrote /)
        assert.ok(written)
    })

    it("an active owner of F still blocks B's write to F", async () => {
        const a = story("A", [F])
        const b = story("B", ["src/b.ts"])
        assert.equal(isActiveOwner(a), true)

        const surface = storyWriteSurface(b, [a, b])
        assert.equal(surface?.ownedElsewhere[F], "A")

        const { result, written } = await writeWith(surface, F)
        assert.match(result, /belongs to story A/)
        assert.equal(written, false)
    })

    it("surfacesOverlap compares normalized paths", () => {
        assert.deepEqual(
            surfacesOverlap(["./src/x.ts", "src/y.ts"], ["src/x.ts", "/src/z.ts"]),
            ["src/x.ts"],
        )
    })
})

describe("replan admission applies the same overlap rule as the gate", () => {
    const options = { immutableStoryIds: [], maxAddedStories: 5 }

    it("reports an active peer's overlapping path, like the gate", () => {
        const a = story("A", [F])
        const result = validateRuntimeReplanMutation(prd([a]), addB([`./${F}`]), options)
        assert.ok(!result.ok)
        assert.equal(result.code, "overlapping_write_surface")
        assert.deepEqual(result.overlap?.owners, [
            { storyId: "A", ownedFiles: [F], collidingPaths: [F] },
        ])
        assert.equal(storyWriteSurface(story("B", ["src/b.ts"]), [a])?.ownedElsewhere[F], "A")
    })

    it("admits B over a merged peer's path, like the gate", () => {
        const a = story("A", [F], true)
        const result = validateRuntimeReplanMutation(prd([a]), addB([F]), options)
        assert.ok(result.ok)
        assert.equal(storyWriteSurface(story("B", [F]), [a])?.ownedElsewhere[F], undefined)
    })
})

describe("Sentry forgets a merged story's declared paths", () => {
    it("does not warn B about F once A has merged", async () => {
        const sentry = new Sentry()
        const env = joinWithCapture(sentry)
        await sentry.onExternalEvent(
            source("conductor"),
            StorySpawnRequest.create({
                storyId: "A",
                prompt: "",
                model: "opus",
                retries: 2,
                timeoutSecs: 600,
                surface: { writes: [F], ownedElsewhere: {} },
            }),
        )
        await sentry.onExternalEvent(
            source("git"),
            StoryMerged.create({ storyId: "A", mode: "worktree" }),
        )
        await sentry.onExternalFunctionCall(
            source("B"),
            FunctionCallItem.rehydrate({
                callId: "call-1",
                name: "Write",
                args: JSON.stringify({ file_path: F, content: "x" }),
            }),
        )
        assert.equal(env.events.filter(Coordination.is).length, 0)
    })
})
