import { describe, it } from "@rstest/core"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { CoordinationBus } from "../../src/runtime/coordination.js"
import type {
    StoryExecOpts,
    StoryExecution,
    StoryExecutor,
} from "../../src/execution/story-executor.js"
import type { StoryRoute } from "../../src/market/routing.js"
import { orchestrate } from "../../src/orchestrate.js"
import {
    loadPrd,
    persistPrdPreserving,
    savePrdAtomic,
    type PrdFile,
} from "../../src/prd.js"
import {
    StoryResult,
    type StorySpawnRequestData,
} from "../../src/semantic-events.js"
import { withTempDir } from "./helpers.js"

/**
 * Form — the shared `persistPrdPreserving` helper in prd.ts was adopted over a
 * writer-local re-read: there are several full-file prd.json writers, and a
 * local re-read would duplicate the merge rule in each.
 *
 * Diagnosis — the stamp is NOT bypassed. Rust's stamp_goal_fingerprint
 * (crates/baro-tui/src/main.rs:3945) is reached on the headless progressive
 * path via 4117 -> 4130 -> 4137. It was erased afterwards, because `PrdFile`
 * has no such member (prd.ts:122-140) and `normalizePrd` rebuilds a whitelist
 * literal (prd.ts:282-291), so every TS full-file write dropped it. The
 * negative control below is what pins that: the same fixture keeps the stamp
 * through the helper and loses it through `savePrdAtomic`. TypeScript still
 * never authors the field.
 */

/** The stamp Rust writes at crates/baro-tui/src/main.rs:3945. */
const RUST_STAMP = "9f2c1ab7e4d05c3b"

function stampedPrdJson(): string {
    return (
        JSON.stringify(
            {
                project: "Goal fingerprint preservation",
                branchName: "goal-fingerprint-preservation",
                description: "A Rust-stamped PRD handed to the orchestrator.",
                goalFingerprint: RUST_STAMP,
                userStories: [
                    {
                        id: "S1",
                        priority: 1,
                        title: "Implement the plan",
                        description: "Story one.",
                        dependsOn: [],
                        retries: 2,
                        acceptance: ["It works"],
                        tests: [],
                        passes: false,
                        completedAt: null,
                        durationSecs: null,
                        model: "opus",
                    },
                ],
            },
            null,
            2,
        ) + "\n"
    )
}

/** Raw read-back: `loadPrd` strips `goalFingerprint`, so it cannot be used. */
function readRaw(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

class PassingExecutor implements StoryExecutor {
    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        _cwd: string,
        environment: CoordinationBus,
        options: StoryExecOpts,
    ): StoryExecution {
        const resultSource = { agentId: request.storyId } as never
        options.registerResultAuthority?.(resultSource)
        setImmediate(() => {
            environment.publish(
                resultSource,
                StoryResult.create({
                    storyId: request.storyId,
                    success: true,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                    runId: request.runId,
                    leaseId: request.leaseId,
                    generation: request.generation,
                }),
            )
        })
        return { dispose: () => {} }
    }
}

/** A real Board persist through a whole local run. */
async function boardPersist(dir: string, prdPath: string): Promise<void> {
    const result = await orchestrate({
        prdPath,
        cwd: dir,
        publishRemote: false,
        withGit: false,
        emitTuiEvents: false,
        withLibrarian: false,
        withMemory: false,
        withSentry: false,
        withCritic: false,
        withSurgeon: false,
        withSupervisor: false,
        intraLevelDelaySecs: 0,
        executor: new PassingExecutor(),
    })
    assert.deepEqual(result.summary.completedStories, ["S1"])
}

describe("goalFingerprint survives the TypeScript full-file write path", () => {
    it("survives a progressive plan-persist followed by a Board persist", async () => {
        await withTempDir("goal-fingerprint-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, stampedPrdJson())
            assert.equal(readRaw(prdPath).goalFingerprint, RUST_STAMP)

            // The commitPrd write of collective-board.ts:495. Its argument is a
            // normalized PrdFile, which by construction carries no
            // goalFingerprint — that is precisely what used to erase it.
            const planned = loadPrd(prdPath)
            assert.equal(
                (planned as PrdFile & { goalFingerprint?: unknown })
                    .goalFingerprint,
                undefined,
                "normalizePrd must not give TypeScript a typed slot for the stamp",
            )
            persistPrdPreserving(prdPath, planned)
            assert.equal(readRaw(prdPath).goalFingerprint, RUST_STAMP)

            await boardPersist(dir, prdPath)

            const after = readRaw(prdPath)
            assert.equal(after.goalFingerprint, RUST_STAMP)
            assert.equal(
                (after.userStories as Record<string, unknown>[])[0]?.passes,
                true,
                "the Board persist really happened",
            )
        })
    })

    it("negative control: the pre-fix primitive drops the stamp on the same fixture", async () => {
        await withTempDir("goal-fingerprint-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(prdPath, stampedPrdJson())

            // The exact pre-fix write: a loadPrd round-trip through
            // savePrdAtomic. normalizePrd's whitelist literal has no
            // goalFingerprint slot, so the stamp is gone after one write.
            savePrdAtomic(prdPath, loadPrd(prdPath))

            assert.equal(readRaw(prdPath).goalFingerprint, undefined)
            assert.equal("goalFingerprint" in readRaw(prdPath), false)

            // Same fixture, same snapshot, helper instead of the primitive.
            writeFileSync(prdPath, stampedPrdJson())
            persistPrdPreserving(prdPath, loadPrd(prdPath))
            assert.equal(readRaw(prdPath).goalFingerprint, RUST_STAMP)
        })
    })

    it("no TypeScript write-site authors or re-stamps the field", async () => {
        await withTempDir("goal-fingerprint-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            // No stamp on disk: Rust never ran. TypeScript must not invent one.
            const unstamped = JSON.parse(stampedPrdJson()) as Record<string, unknown>
            delete unstamped.goalFingerprint
            writeFileSync(prdPath, JSON.stringify(unstamped, null, 2) + "\n")

            persistPrdPreserving(prdPath, loadPrd(prdPath))
            await boardPersist(dir, prdPath)

            assert.equal("goalFingerprint" in readRaw(prdPath), false)
        })
    })
})
