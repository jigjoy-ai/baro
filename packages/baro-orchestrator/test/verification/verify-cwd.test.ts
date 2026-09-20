import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { GitGate } from "../../src/integration/git.js"
import { WorktreeManager } from "../../src/integration/worktree.js"
import {
    integrationCwdResolver,
    type VerifyCwdResolver,
} from "../../src/verification/command-cwd.js"
import {
    verifyBuild,
    type VerifyCommandSpec,
    type VerifyPlan,
} from "../../src/verification/verify.js"
import { withTempDir } from "../execution/helpers.js"
import { removeWorktreeRun, uniqueRunId } from "../integration/worktree-fixture.js"

/** The real layout: <tmp>/baro-worktrees/<runId>/{__run,<agentId>}. */
function runLayout(dir: string): { integrationRoot: string; storyRoot: string } {
    const base = join(dir, "baro-worktrees", "run-1")
    const integrationRoot = join(base, "__run")
    const storyRoot = join(base, "S1")
    mkdirSync(integrationRoot, { recursive: true })
    return { integrationRoot, storyRoot }
}

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

/**
 * Appends one line per attempt and fails on the first, so retries are
 * countable. The tail names an environment failure because only an
 * environment or time-ceiling classification earns the single retry.
 */
function flakyProbe(log: string): string[] {
    return [
        "-e",
        `const fs = require('fs');` +
            `fs.appendFileSync(${JSON.stringify(log)}, process.cwd() + '\\n');` +
            `const n = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;` +
            `if (n === 1) { console.error("Error: Cannot find module 'flake' - attempt 1 fails"); process.exit(1); }`,
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

describe("integrationCwdResolver", () => {
    it("yields the integration worktree while it exists", async () => {
        await withTempDir("baro-icr-live-", async (dir) => {
            const { integrationRoot } = runLayout(dir)
            assert.equal(integrationCwdResolver(integrationRoot, dir)(), integrationRoot)
        })
    })

    it("falls back to the host checkout once the integration worktree is gone", async () => {
        await withTempDir("baro-icr-gone-", async (dir) => {
            const { integrationRoot } = runLayout(dir)
            const resolve = integrationCwdResolver(integrationRoot, dir)
            rmSync(integrationRoot, { recursive: true, force: true })
            assert.equal(resolve(), dir)
        })
    })

    it("never yields a story worktree, even when asked for one that exists", async () => {
        await withTempDir("baro-icr-story-", async (dir) => {
            const { integrationRoot, storyRoot } = runLayout(dir)
            mkdirSync(storyRoot, { recursive: true })
            assert.equal(integrationCwdResolver(integrationRoot, dir)(), integrationRoot)
        })
    })
})

describe("verifyBuild run-cwd resolution (#168)", () => {
    it("runs in the integration worktree even when the captured cwd is a cleaned-up story worktree", async () => {
        await withTempDir("baro-verify-merge-cleanup-", async (dir) => {
            const { integrationRoot, storyRoot } = runLayout(dir)
            // merge → cleanup: the story worktree is gone, and the twin of the
            // package it declared now lives under the integration root.
            const twin = join(integrationRoot, "packages", "baro-orchestrator")
            mkdirSync(twin, { recursive: true })
            assert.equal(existsSync(storyRoot), false)
            const log = join(dir, "cwd.log")

            // The bug: the cwd captured before the merge is the story worktree.
            const result = await verifyBuild(storyRoot, {
                emitActivity: () => {},
                sleep: async () => {},
                resolveRunCwd: integrationCwdResolver(integrationRoot, dir),
                plan: planOf(
                    {
                        label: "npm run build",
                        tool: process.execPath,
                        args: cwdProbe(log),
                    },
                    {
                        label: "npm run test -w packages/baro-orchestrator",
                        tool: process.execPath,
                        args: cwdProbe(log),
                        cwd: join(storyRoot, "packages", "baro-orchestrator"),
                    },
                ),
            })

            assert.equal(result.ok, true, "verification passes instead of ENOENT")
            assert.deepEqual(result.failures, [])
            assertRanIn(log, integrationRoot, twin)
        })
    })

    it("consults the resolver at every spawn, not once when the plan was built", async () => {
        await withTempDir("baro-verify-per-spawn-", async (dir) => {
            const { integrationRoot } = runLayout(dir)
            const firstRoot = join(dir, "before-remateralize")
            mkdirSync(firstRoot, { recursive: true })
            const log = join(dir, "cwd.log")

            // Attempt 1 fails in the stale root; the root is re-materialised
            // before attempt 2, which must land in the new one.
            const roots = [firstRoot, integrationRoot]
            const seen: string[] = []
            const resolveRunCwd: VerifyCwdResolver = () => {
                const next = roots.shift() ?? integrationRoot
                seen.push(next)
                return next
            }

            const result = await verifyBuild(dir, {
                emitActivity: () => {},
                sleep: async () => {},
                resolveRunCwd,
                plan: planOf({
                    label: "cargo test",
                    tool: process.execPath,
                    args: flakyProbe(log),
                }),
            })

            assert.equal(result.ok, true)
            assert.equal(result.commands[0]?.retriedAfterFailure, true)
            assert.deepEqual(seen, [firstRoot, integrationRoot])
            assertRanIn(log, firstRoot, integrationRoot)
        })
    })

    it("defaults an integration-root cwd to a spawn-time fallback on the host checkout", async () => {
        await withTempDir("baro-verify-default-resolver-", async (dir) => {
            const { integrationRoot } = runLayout(dir)
            const host = join(dir, "host-checkout")
            mkdirSync(host, { recursive: true })
            const log = join(dir, "cwd.log")

            const plan = planOf({
                label: "npm run build",
                tool: process.execPath,
                args: cwdProbe(log),
            })
            // Torn down between planning and the spawn, with no resolver given.
            rmSync(integrationRoot, { recursive: true, force: true })

            const result = await verifyBuild(integrationRoot, {
                emitActivity: () => {},
                sleep: async () => {},
                hostRepoRoot: host,
                plan,
            })

            assert.equal(result.ok, true)
            assertRanIn(log, host)
        })
    })

    it("does not divert a story gate to the host checkout when its own worktree vanishes", async () => {
        await withTempDir("baro-verify-story-gate-", async (dir) => {
            const { storyRoot } = runLayout(dir)
            const host = join(dir, "host-checkout")
            mkdirSync(host, { recursive: true })
            const log = join(dir, "cwd.log")

            const result = await verifyBuild(storyRoot, {
                emitActivity: () => {},
                sleep: async () => {},
                hostRepoRoot: host,
                plan: planOf({
                    label: "npm run build",
                    tool: process.execPath,
                    args: cwdProbe(log),
                }),
            })

            assert.equal(result.ok, false, "grading the wrong tree is worse than failing")
            assert.deepEqual(lines(log), [], "nothing was spawned")
        })
    })
})

describe("a vanished verification cwd is environment, not a regression (#168)", () => {
    it("stamps environment:true with the exact tail and never retries", async () => {
        await withTempDir("baro-verify-env-", async (dir) => {
            const { integrationRoot } = runLayout(dir)
            const ghost = join(integrationRoot, "packages", "removed-by-cleanup")
            const log = join(dir, "cwd.log")
            const waits: number[] = []

            const result = await verifyBuild(integrationRoot, {
                emitActivity: () => {},
                sleep: async (ms) => void waits.push(ms),
                plan: planOf({
                    label: "npm run test -w packages/removed-by-cleanup",
                    tool: process.execPath,
                    args: cwdProbe(log),
                    cwd: ghost,
                }),
            })

            const command = result.commands[0]!
            assert.equal(command.status, "failed")
            assert.equal(command.retryable, false)
            assert.equal(command.environment, true)
            assert.equal(command.tail, `verification cwd missing: ${ghost}`)
            assert.equal(command.retriedAfterFailure, undefined)
            assert.deepEqual(waits, [], "a terminal environment failure waits for nothing")
            assert.deepEqual(lines(log), [], "nothing was ever spawned")
            // Still reported, so the gate cannot go silently green — but the
            // flag is what tells classification this is not a test regression.
            assert.deepEqual(
                result.failures.map(({ cmd }) => cmd),
                ["npm run test -w packages/removed-by-cleanup"],
            )
        })
    })

    it("leaves a genuine test failure unstamped, so the two buckets stay distinct", async () => {
        await withTempDir("baro-verify-regression-", async (dir) => {
            const { integrationRoot } = runLayout(dir)

            const result = await verifyBuild(integrationRoot, {
                emitActivity: () => {},
                sleep: async () => {},
                plan: planOf({
                    label: "npm run test",
                    tool: process.execPath,
                    args: ["-e", "console.error('AssertionError'); process.exit(1)"],
                    origin: "declared",
                }),
            })

            const command = result.commands[0]!
            assert.equal(command.status, "failed")
            assert.equal(command.environment, undefined)
        })
    })
})

// ── deferred cleanup ─────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function initRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "baro-verify-cwd-repo-"))
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "t@t.t")
    git(repo, "config", "user.name", "t")
    writeFileSync(join(repo, "a.txt"), "one\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "init")
    return repo
}

describe("WorktreeManager.retainForVerification (#168)", () => {
    let repo: string
    let logs: string[]
    let mgr: WorktreeManager
    let runId: string

    beforeEach(() => {
        repo = initRepo()
        logs = []
        runId = uniqueRunId("run-verify-cwd")
        mgr = new WorktreeManager(repo, new GitGate(), runId, {
            onLog: (line) => logs.push(line),
            integrationRoot: repo,
        })
    })

    afterEach(async () => {
        try {
            await mgr.cleanupAll()
        } catch {
            /* the lease cases deliberately leave work behind */
        }
        await removeWorktreeRun(repo, runId)
        rmSync(repo, { recursive: true, force: true })
    })

    it("defers cleanup while a lease is open and removes on release, not on the sweep", async () => {
        const path = (await mgr.create("S1"))!
        assert.ok(existsSync(path))
        const release = mgr.retainForVerification("S1")

        await mgr.cleanup("S1")
        assert.equal(mgr.activePath("S1"), path, "the lease held the worktree")
        assert.equal(existsSync(path), true)
        assert.ok(
            logs.some((line) => line.includes("deferred cleanup of story S1")),
            "the skip is logged, not thrown",
        )

        release()
        await mgr.cleanupAll()

        assert.equal(mgr.activePath("S1"), null)
        assert.equal(existsSync(path), false)
        // removeWorktreeQuiet stamps its caller: the release did the removal,
        // so the final sweep found nothing of S1's left to take.
        assert.ok(
            logs.some((line) => line.includes(`removed worktree ${path} (cleanup)`)),
            "removal was performed by the deferred cleanup the release started",
        )
        assert.equal(
            logs.some((line) => line.includes(`(cleanupAll)`)),
            false,
        )
    })

    it("skips a leased worktree in cleanupAll without throwing, and reports it retained", async () => {
        const path = (await mgr.create("S1"))!
        const release = mgr.retainForVerification("S1")

        await mgr.cleanupAll()

        assert.equal(existsSync(path), true, "an in-flight verification keeps its cwd")
        assert.equal(mgr.activePath("S1"), path)
        assert.equal(mgr.hasRetainedWorktrees(), true)

        release()
        await mgr.cleanupAll()
        assert.equal(existsSync(path), false)
    })

    it("removes only after the last of several leases releases, and release is idempotent", async () => {
        const path = (await mgr.create("S1"))!
        const first = mgr.retainForVerification("S1")
        const second = mgr.retainForVerification("S1")

        await mgr.cleanup("S1")
        first()
        first()
        await mgr.cleanupAll()
        assert.equal(existsSync(path), true, "one lease is still open")

        second()
        await mgr.cleanupAll()
        assert.equal(existsSync(path), false)
    })

    it("leaves an unleased story's cleanup exactly as it was", async () => {
        const path = (await mgr.create("S1"))!
        await mgr.cleanup("S1")

        assert.equal(mgr.activePath("S1"), null)
        assert.equal(existsSync(path), false)
    })
})
