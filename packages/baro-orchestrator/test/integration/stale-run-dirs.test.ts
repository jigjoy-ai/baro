import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
    StoryExecOpts,
    StoryExecution,
    StoryExecutor,
} from "../../src/execution/story-executor.js"
import {
    LEGACY_IDLE_MS,
    claimRunDir,
    pidInRunId,
    reclaimStaleRunDirs,
} from "../../src/integration/stale-run-dirs.js"
import type { StoryRoute } from "../../src/market/routing.js"
import { orchestrate } from "../../src/orchestrate.js"
import type { CoordinationBus } from "../../src/runtime/coordination.js"
import { StoryResult, type StorySpawnRequestData } from "../../src/semantic-events.js"

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** A pid that existed and has exited. */
function deadPid(): number {
    return spawnSync(process.execPath, ["-e", ""]).pid!
}

let scratch: string
let root: string
let repo: string
let logs: string[]

beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "baro-stale-runs-")))
    root = join(scratch, "baro-worktrees")
    mkdirSync(root)
    repo = join(scratch, "repo")
    mkdirSync(repo)
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "t@t.t")
    git(repo, "config", "user.name", "t")
    writeFileSync(join(repo, "a.txt"), "a\n")
    writeFileSync(join(repo, ".gitignore"), "target/\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "init")
    logs = []
})

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
})

function addWorktree(runId: string, dir: string, branch: string): string {
    const path = join(root, runId, dir, "repo")
    git(repo, "worktree", "add", "-b", branch, path, "HEAD")
    return path
}

function markOwner(runId: string, pid: number): void {
    writeFileSync(join(root, runId, `.baro-run-${pid}.pid`), `${pid}\n`)
}

function registeredWorktrees(): string[] {
    return git(repo, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
}

function reclaim(extra: Partial<Parameters<typeof reclaimStaleRunDirs>[0]> = {}) {
    return reclaimStaleRunDirs({
        currentRunId: "run-current",
        root,
        log: (line) => logs.push(line),
        ...extra,
    })
}

describe("reclaimStaleRunDirs", () => {
    it("removes a dead run's merged story and integration worktrees and reports the reclaim", async () => {
        git(repo, "branch", "baro/goal")
        const story = addWorktree("run-dead", "S1", "baro-wt/run-dead/S1")
        const integration = join(root, "run-dead", "__run", "repo")
        git(repo, "worktree", "add", integration, "baro/goal")
        mkdirSync(join(story, "target"))
        writeFileSync(join(story, "target", "artifact"), "x".repeat(4096))
        markOwner("run-dead", deadPid())

        const summary = await reclaim()

        assert.deepEqual(summary.reclaimed, [join(root, "run-dead")])
        assert.equal(existsSync(join(root, "run-dead")), false)
        assert.deepEqual(registeredWorktrees(), [repo])
        assert.ok(summary.bytes >= 4096)
        assert.ok(logs.some((line) => /reclaimed 1 leftover worktree dir/.test(line)), logs.join("\n"))
        assert.equal(git(repo, "rev-parse", "--verify", "baro-wt/run-dead/S1"), git(repo, "rev-parse", "main"))
    })

    it("keeps a dead run's story worktree whose branch has unmerged commits", async () => {
        const merged = addWorktree("run-dead", "S1", "baro-wt/run-dead/S1")
        const unmerged = addWorktree("run-dead", "S2", "baro-wt/run-dead/S2")
        writeFileSync(join(unmerged, "s2.txt"), "work\n")
        git(unmerged, "add", "-A")
        git(unmerged, "commit", "-m", "S2 work")
        markOwner("run-dead", deadPid())

        const summary = await reclaim()

        assert.equal(existsSync(unmerged), true, "unmerged work must stay")
        assert.equal(existsSync(join(unmerged, "s2.txt")), true)
        assert.equal(existsSync(merged), false)
        assert.deepEqual(summary.kept, [unmerged])
        assert.deepEqual(registeredWorktrees().sort(), [repo, unmerged].sort())
        assert.ok(logs.some((line) => line.includes(unmerged) && /not merged/.test(line)), logs.join("\n"))
    })

    it("keeps a dead run's story worktree with uncommitted changes", async () => {
        const dirty = addWorktree("run-dead", "S1", "baro-wt/run-dead/S1")
        writeFileSync(join(dirty, "a.txt"), "edited\n")
        markOwner("run-dead", deadPid())

        const summary = await reclaim()

        assert.equal(existsSync(join(dirty, "a.txt")), true)
        assert.deepEqual(summary.kept, [dirty])
        assert.deepEqual(summary.reclaimed, [])
    })

    it("leaves a run whose owner is alive, and the current run, untouched", async () => {
        const live = addWorktree("run-live", "S1", "baro-wt/run-live/S1")
        markOwner("run-live", process.pid)
        markOwner("run-live", deadPid())
        const current = addWorktree("run-current", "S1", "baro-wt/run-current/S1")
        markOwner("run-current", deadPid())

        const summary = await reclaim()

        assert.equal(existsSync(live), true)
        assert.equal(existsSync(current), true)
        assert.deepEqual(summary.reclaimed, [])
        assert.deepEqual(logs, [])
    })

    it("treats a markerless run dir as dead only once it has been idle past the threshold", async () => {
        const legacy = addWorktree("stopped-1", "S1", "baro-wt/stopped-1/S1")

        assert.deepEqual((await reclaim()).reclaimed, [], "a recently touched markerless dir may be a live older run")
        assert.equal(existsSync(legacy), true)

        const later = Date.now() + LEGACY_IDLE_MS + 60_000
        const summary = await reclaim({ now: later })
        assert.deepEqual(summary.reclaimed, [join(root, "stopped-1")])
        assert.equal(existsSync(join(root, "stopped-1")), false)
    })

    it("keeps an idle markerless run whose run id names a live process", async () => {
        const runId = `run-${process.pid}`
        const legacy = addWorktree(runId, "S1", `baro-wt/${runId}/S1`)

        const summary = await reclaim({ now: Date.now() + 2 * LEGACY_IDLE_MS })

        assert.equal(existsSync(legacy), true)
        assert.deepEqual(summary.reclaimed, [])
    })

    it("removes a dead run dir whose worktree admin entry is already gone", async () => {
        const orphan = addWorktree("run-dead", "S1", "baro-wt/run-dead/S1")
        rmSync(join(repo, ".git", "worktrees"), { recursive: true, force: true })
        markOwner("run-dead", deadPid())

        const summary = await reclaim()

        assert.equal(existsSync(orphan), false)
        assert.deepEqual(summary.reclaimed, [join(root, "run-dead")])
    })
})

class CommittingExecutor implements StoryExecutor {
    readonly ownedDuringRun: boolean[] = []

    constructor(private readonly runDir: string) {}

    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        cwd: string,
        environment: CoordinationBus,
        options: StoryExecOpts,
    ): StoryExecution {
        this.ownedDuringRun.push(existsSync(join(this.runDir, `.baro-run-${process.pid}.pid`)))
        writeFileSync(join(cwd, `${request.storyId}.txt`), "done\n")
        git(cwd, "add", "-A")
        git(cwd, "commit", "-m", request.storyId)
        const source = { agentId: request.storyId } as never
        options.registerResultAuthority?.(source)
        setImmediate(() => {
            environment.publish(
                source,
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

describe("orchestrate() run start", () => {
    let savedTmpdir: string | undefined
    let savedCleanup: string | undefined
    let stderrWrite: typeof process.stderr.write

    beforeEach(() => {
        savedTmpdir = process.env.TMPDIR
        savedCleanup = process.env.BARO_RUN_START_CLEANUP
        process.env.TMPDIR = scratch
        delete process.env.BARO_RUN_START_CLEANUP
        stderrWrite = process.stderr.write
    })

    afterEach(() => {
        process.stderr.write = stderrWrite
        if (savedTmpdir === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = savedTmpdir
        if (savedCleanup === undefined) delete process.env.BARO_RUN_START_CLEANUP
        else process.env.BARO_RUN_START_CLEANUP = savedCleanup
    })

    async function runOnce(): Promise<{
        stderr: string[]
        runId: string
        executor: CommittingExecutor
        completed: readonly string[]
    }> {
        const prdPath = join(repo, "prd.json")
        writeFileSync(prdPath, JSON.stringify({
            project: "reclaim",
            branchName: "baro/reclaim",
            description: "reclaim",
            userStories: [{
                id: "S1", priority: 1, title: "S1", description: "S1", dependsOn: [], retries: 1,
                acceptance: ["S1"], tests: [], passes: false, completedAt: null, durationSecs: null,
                model: "standard",
            }],
        }) + "\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-m", "prd")
        const runId = "run-reclaim-test"
        const executor = new CommittingExecutor(join(root, runId))
        const stderr: string[] = []
        process.stderr.write = ((chunk: string | Uint8Array) => {
            stderr.push(String(chunk))
            return true
        }) as typeof process.stderr.write

        const result = await orchestrate({
            prdPath, cwd: repo, runId, continueRun: false, publishRemote: false,
            withGit: true, withWorktrees: true, emitTuiEvents: false, withLibrarian: false,
            withMemory: false, withSentry: false, withCritic: false, withSurgeon: false,
            withSupervisor: false, intraLevelDelaySecs: 0, executor,
        })
        process.stderr.write = stderrWrite
        return { stderr, runId, executor, completed: result.summary.completedStories }
    }

    it("reclaims a dead run's worktree dir, prints it, and owns its own run dir until teardown", async () => {
        const stale = addWorktree("run-dead", "S1", "baro-wt/run-dead/S1")
        markOwner("run-dead", deadPid())
        const { stderr, runId, executor, completed } = await runOnce()

        assert.deepEqual(completed, ["S1"])
        assert.equal(existsSync(stale), false)
        assert.equal(existsSync(join(root, "run-dead")), false)
        assert.ok(
            stderr.some((line) => line.startsWith("[worktree] reclaimed 1 leftover worktree dir")),
            stderr.join(""),
        )
        assert.deepEqual(executor.ownedDuringRun, [true])
        assert.equal(existsSync(join(root, runId)), false, "teardown releases the run's own dir")
    })

    it("leaves dead runs' dirs alone under BARO_RUN_START_CLEANUP=0", async () => {
        const stale = addWorktree("run-dead", "S1", "baro-wt/run-dead/S1")
        markOwner("run-dead", deadPid())
        process.env.BARO_RUN_START_CLEANUP = "0"
        const { stderr, completed } = await runOnce()

        assert.deepEqual(completed, ["S1"])
        assert.equal(existsSync(stale), true)
        assert.equal(stderr.some((line) => line.includes("reclaimed")), false, stderr.join(""))
    })
})

describe("claimRunDir", () => {
    it("marks the run dir with this pid and removes it on release when empty", () => {
        const runDir = join(root, "run-x")
        const release = claimRunDir(runDir)
        assert.deepEqual(readdirSync(runDir), [`.baro-run-${process.pid}.pid`])
        release()
        assert.equal(existsSync(runDir), false)
    })

    it("leaves a run dir that still holds retained worktrees", () => {
        const runDir = join(root, "run-x")
        const release = claimRunDir(runDir)
        mkdirSync(join(runDir, "S1"))
        release()
        assert.deepEqual(readdirSync(runDir), ["S1"])
    })
})

describe("pidInRunId", () => {
    it("reads the pid from the TUI and orchestrate run id forms only", () => {
        assert.equal(pidInRunId("run-4242"), 4242)
        assert.equal(pidInRunId("run-1731400000000-4242"), 4242)
        assert.equal(pidInRunId("run-progressive-00ab12cd34ef5678"), null)
        assert.equal(pidInRunId("resumed-1731400000000"), null)
    })
})
