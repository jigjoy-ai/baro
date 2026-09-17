import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    defaultSleep,
    resolveCommandCwd,
    RETRY_BACKOFF_MS,
} from "../../src/verification/command-cwd.js"
import { pathAliases } from "../../src/runtime/worktree-path.js"
import { withTempDir } from "../execution/helpers.js"

/** The real layout: <tmp>/baro-worktrees/<runId>/{__run,<agentId>}. */
function worktreeLayout(dir: string): { runCwd: string; storyRoot: string } {
    const base = join(dir, "baro-worktrees", "run-1")
    const runCwd = join(base, "__run")
    const storyRoot = join(base, "S1")
    mkdirSync(runCwd, { recursive: true })
    return { runCwd, storyRoot }
}

describe("resolveCommandCwd", () => {
    it("returns the run cwd for a spec with no cwd", async () => {
        await withTempDir("baro-cwd-none-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            assert.equal(resolveCommandCwd(runCwd, undefined), runCwd)
        })
    })

    it("passes through a spec cwd equal to, or strictly under, the run cwd", async () => {
        await withTempDir("baro-cwd-under-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            const workspace = join(runCwd, "packages", "baro-app")
            mkdirSync(workspace, { recursive: true })

            assert.equal(resolveCommandCwd(runCwd, runCwd), runCwd)
            assert.equal(resolveCommandCwd(runCwd, workspace), workspace)
        })
    })

    it("treats /var and /private/var as the same directory", async () => {
        await withTempDir("baro-cwd-alias-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            const workspace = join(runCwd, "packages", "baro-app")
            mkdirSync(workspace, { recursive: true })

            for (const alias of pathAliases(workspace)) {
                assert.equal(
                    resolveCommandCwd(runCwd, alias),
                    alias,
                    `${alias} is inside the run cwd under either name`,
                )
            }
        })
    })

    it("remaps a removed story worktree path onto its twin under the run cwd", async () => {
        await withTempDir("baro-cwd-remap-", async (dir) => {
            const { runCwd, storyRoot } = worktreeLayout(dir)
            // The merge already ran `git worktree remove`, so storyRoot is gone
            // while the same relative package exists in the integration root.
            const twin = join(runCwd, "packages", "baro-orchestrator")
            mkdirSync(twin, { recursive: true })

            const removed = join(storyRoot, "packages", "baro-orchestrator")
            assert.equal(resolveCommandCwd(runCwd, removed), twin)
        })
    })

    it("falls back to the run cwd when a removed story worktree has no twin", async () => {
        await withTempDir("baro-cwd-notwin-", async (dir) => {
            const { runCwd, storyRoot } = worktreeLayout(dir)
            const removed = join(storyRoot, "packages", "never-created")

            assert.equal(resolveCommandCwd(runCwd, removed), runCwd)
        })
    })

    it("falls back to the run cwd for an out-of-tree declared `cd` scope", async () => {
        await withTempDir("baro-cwd-outoftree-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            const outside = join(dir, "somewhere-else")
            mkdirSync(outside, { recursive: true })

            assert.equal(resolveCommandCwd(runCwd, outside), runCwd)
            assert.equal(resolveCommandCwd(runCwd, join(dir, "gone")), runCwd)
        })
    })

    it("never returns a path belonging to another run's worktree", async () => {
        await withTempDir("baro-cwd-otherrun-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            const otherRun = join(dir, "baro-worktrees", "run-2", "S1", "packages")
            mkdirSync(otherRun, { recursive: true })

            assert.equal(resolveCommandCwd(runCwd, otherRun), runCwd)
        })
    })
})

describe("retry backoff", () => {
    it("is a fixed 2s wait with no exponential growth or jitter", () => {
        assert.equal(RETRY_BACKOFF_MS, 2000)
    })

    it("resolves without holding the process open", async () => {
        await defaultSleep(1)
    })
})
