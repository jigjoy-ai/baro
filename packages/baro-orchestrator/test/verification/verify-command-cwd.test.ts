import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    defaultSleep,
    resolveCommandCwd,
    RETRY_BACKOFF_MS,
} from "../../src/verification/command-cwd.js"
import { pathAliases } from "../../src/runtime/worktree-path.js"
import {
    verifyBuild,
    type VerifyCommandSpec,
    type VerifyPlan,
} from "../../src/verification/verify.js"
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

function planOf(...commands: VerifyCommandSpec[]): VerifyPlan {
    return { commands } as VerifyPlan
}

/** Records the directory each attempt actually started in, one line per spawn. */
function cwdProbe(log: string): string[] {
    return [
        "-e",
        `require('fs').appendFileSync(${JSON.stringify(log)}, process.cwd() + '\\n')`,
    ]
}

/** Appends one line per attempt and fails on the first, so retries are countable. */
function flakyProbe(log: string): string[] {
    return [
        "-e",
        `const fs = require('fs');` +
            `fs.appendFileSync(${JSON.stringify(log)}, process.cwd() + '\\n');` +
            `const n = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;` +
            `if (n === 1) { console.error('attempt 1 fails'); process.exit(1); }`,
    ]
}

function lines(log: string): string[] {
    return existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
        : []
}

/** The child reports the realpath; the fixture root is the symlinked name. */
function assertRanIn(log: string, ...expected: string[]): void {
    assert.deepEqual(
        lines(log).map((p) => realpathSync(p)),
        expected.map((p) => realpathSync(p)),
    )
}

describe("verifyBuild working-directory resolution", () => {
    it("runs a spec with no cwd at the integration root", async () => {
        await withTempDir("baro-verify-cwd-default-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            const log = join(dir, "cwd.log")

            const result = await verifyBuild(runCwd, {
                emitActivity: () => {},
                sleep: async () => {},
                plan: planOf({
                    label: "cargo build",
                    tool: process.execPath,
                    args: cwdProbe(log),
                }),
            })

            assert.equal(result.ok, true)
            assertRanIn(log, runCwd)
        })
    })

    it("runs a removed story worktree's spec cwd at its twin under the run cwd", async () => {
        await withTempDir("baro-verify-cwd-remap-", async (dir) => {
            const { runCwd, storyRoot } = worktreeLayout(dir)
            const twin = join(runCwd, "packages", "baro-orchestrator")
            mkdirSync(twin, { recursive: true })
            const log = join(dir, "cwd.log")

            const result = await verifyBuild(runCwd, {
                emitActivity: () => {},
                sleep: async () => {},
                plan: planOf({
                    label: "npm run test (workspace)",
                    tool: process.execPath,
                    args: cwdProbe(log),
                    cwd: join(storyRoot, "packages", "baro-orchestrator"),
                }),
            })

            assert.equal(result.ok, true)
            assertRanIn(log, twin)
        })
    })

    it("falls back to the run cwd for an out-of-tree declared `cd` scope", async () => {
        await withTempDir("baro-verify-cwd-outoftree-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            const outside = join(dir, "somewhere-else")
            mkdirSync(outside, { recursive: true })
            const log = join(dir, "cwd.log")

            const result = await verifyBuild(runCwd, {
                emitActivity: () => {},
                sleep: async () => {},
                plan: planOf({
                    label: "npm run lint (declared)",
                    tool: process.execPath,
                    args: cwdProbe(log),
                    cwd: outside,
                }),
            })

            assert.equal(result.ok, true)
            assertRanIn(log, runCwd)
        })
    })

    it("fails a missing working directory immediately and never retries it", async () => {
        await withTempDir("baro-verify-cwd-missing-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            const ghost = join(runCwd, "packages", "ghost")
            const log = join(dir, "cwd.log")
            const events: unknown[] = []

            const result = await verifyBuild(runCwd, {
                emitActivity: (event) => void events.push(event),
                sleep: async () => {},
                plan: planOf({
                    label: "npm run build (ghost workspace)",
                    tool: process.execPath,
                    args: cwdProbe(log),
                    cwd: ghost,
                }),
            })

            assert.equal(result.ok, false)
            const command = result.commands[0]!
            assert.equal(command.status, "failed")
            assert.equal(
                command.tail,
                `verification cwd missing: ${ghost}`,
            )
            assert.equal(command.retryable, false)
            assert.equal(command.retriedAfterFailure, undefined)
            assert.deepEqual(lines(log), [], "nothing was ever spawned")
            assert.deepEqual(events, [], "a terminal failure announces no retry")
        })
    })
})

describe("verifyBuild retry backoff", () => {
    it("waits RETRY_BACKOFF_MS once before the single retry", async () => {
        await withTempDir("baro-verify-backoff-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            const log = join(dir, "cwd.log")
            const waits: number[] = []

            const result = await verifyBuild(runCwd, {
                emitActivity: () => {},
                sleep: async (ms) => void waits.push(ms),
                plan: planOf({
                    label: "cargo test (flaky)",
                    tool: process.execPath,
                    args: flakyProbe(log),
                }),
            })

            assert.equal(result.ok, true)
            assert.equal(result.commands[0]?.retriedAfterFailure, true)
            assert.deepEqual(waits, [RETRY_BACKOFF_MS])
            assert.equal(lines(log).length, 2)
        })
    })

    it("honours an abort raised during the backoff, before attempt 2 spawns", async () => {
        await withTempDir("baro-verify-backoff-abort-", async (dir) => {
            const { runCwd } = worktreeLayout(dir)
            const log = join(dir, "cwd.log")
            const controller = new AbortController()

            await assert.rejects(
                verifyBuild(runCwd, {
                    signal: controller.signal,
                    emitActivity: () => {},
                    sleep: async () => controller.abort(),
                    plan: planOf({
                        label: "cargo test (cancelled)",
                        tool: process.execPath,
                        args: flakyProbe(log),
                    }),
                }),
            )

            assert.equal(lines(log).length, 1, "attempt 2 never started")
        })
    })
})
