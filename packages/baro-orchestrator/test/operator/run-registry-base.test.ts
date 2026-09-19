import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, afterEach, before, describe, it } from "node:test"

import { GitGate } from "../../src/integration/git.js"
import { IntegrationWorktree } from "../../src/integration/integration-worktree.js"
import { systemPrompt } from "../../src/operator/operator-session.js"
import { RunRegistry, type RunRecord } from "../../src/operator/run-registry.js"
import { removeWorktreeRun, uniqueRunId } from "../integration/worktree-fixture.js"

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** `main` with one commit, then the checkout moved to `feature`, one commit ahead. */
function repoAheadOfMain(): { repo: string; mainSha: string; hostSha: string } {
    const repo = mkdtempSync(join(tmpdir(), "baro-base-run-"))
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "t@t.t")
    git(repo, "config", "user.name", "t")
    writeFileSync(join(repo, "a.txt"), "a\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "init")
    const mainSha = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-b", "feature")
    writeFileSync(join(repo, "b.txt"), "b\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "feature")
    return { repo, mainSha, hostSha: git(repo, "rev-parse", "HEAD") }
}

let dir: string
let fakeBaro: string
let savedBaroBin: string | undefined
const cleanups: Array<() => Promise<void> | void> = []

before(() => {
    dir = mkdtempSync(join(tmpdir(), "baro-operator-base-"))
    fakeBaro = join(dir, "fake-baro.js")
    writeFileSync(
        fakeBaro,
        `#!/usr/bin/env node
const fs = require("fs")
const goal = process.argv[2] ?? ""
fs.writeFileSync(${JSON.stringify(dir)} + "/argv-" + goal.replace(/\\W+/g, "-") + ".json", JSON.stringify(process.argv.slice(2)))
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
setTimeout(() => {
  say({ type: "done", success: true, stats: { stories_completed: 0, stories_skipped: 0 } })
  process.exit(0)
}, goal.startsWith("slow") ? 400 : 20)
`,
    )
    chmodSync(fakeBaro, 0o755)
    savedBaroBin = process.env.BARO_BIN
    process.env.BARO_BIN = fakeBaro
})

after(() => {
    if (savedBaroBin === undefined) delete process.env.BARO_BIN
    else process.env.BARO_BIN = savedBaroBin
    rmSync(dir, { recursive: true, force: true })
})

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
})

function finished(registry: RunRegistry, id: string): Promise<RunRecord> {
    return new Promise((resolve) => {
        const tick = setInterval(() => {
            const run = registry.get(id)
            if (run?.finishedAt !== null) {
                clearInterval(tick)
                resolve(run!)
            }
        }, 10)
    })
}

function argvOf(goal: string): string[] {
    return JSON.parse(readFileSync(join(dir, `argv-${goal.replace(/\W+/g, "-")}.json`), "utf8"))
}

describe("operator prompt without a base ref", () => {
    it("states one checkout serves one run's branch and offers base for independent goals", () => {
        const prompt = systemPrompt("/tmp/project")
        assert.match(prompt, /One checkout serves one run's branch/)
        assert.match(prompt, /independent goal waits until the active run in this repository finishes/)
        assert.match(prompt, /delegate it with `base`/)
        assert.doesNotMatch(prompt, /\bpush(e[sd]|ing)?\b/iu)
        assert.doesNotMatch(prompt, /\bpublish(e[sd]|ing)?\b/iu)
        assert.doesNotMatch(prompt, /pull request|\bPR\b/u)
    })
})

describe("RunRegistry.delegate with a base ref", () => {
    it("starts two base=main runs at once, keyed per run, each with --base main", async () => {
        const { repo, hostSha } = repoAheadOfMain()
        cleanups.push(() => rmSync(repo, { recursive: true, force: true }))
        const registry = new RunRegistry()

        const first = registry.delegate("slow base one", repo, "main")
        const second = registry.delegate("slow base two", repo, "main")
        assert.equal(first.behind, null)
        assert.equal(second.behind, null)
        assert.equal(registry.stateOf(first.run), "running")
        assert.equal(registry.stateOf(second.run), "running")
        assert.deepEqual(registry.activeKeys().sort(), [
            `${repo}#${first.run.id}`,
            `${repo}#${second.run.id}`,
        ])

        await finished(registry, first.run.id)
        await finished(registry, second.run.id)
        for (const goal of ["slow base one", "slow base two"]) {
            const argv = argvOf(goal)
            const at = argv.indexOf("--base")
            assert.ok(at > 0, argv.join(" "))
            assert.equal(argv[at + 1], "main")
        }
        assert.equal(git(repo, "rev-parse", "HEAD"), hostSha)
        assert.equal(git(repo, "branch", "--show-current"), "feature")
        assert.equal(git(repo, "status", "--porcelain"), "")
    })

    it("keeps per-cwd queueing and no --base for runs without a base", async () => {
        const started: string[] = []
        const registry = new RunRegistry({ onStarted: (run) => started.push(run.id) })
        const holder = registry.delegate("slow plain holder", dir)
        const based = registry.delegate("quick based", dir, "main")
        const queued = registry.delegate("quick plain queued", dir)
        assert.equal(based.behind, null)
        assert.equal(queued.behind?.id, holder.run.id)

        // The base run exiting must not release the checkout's slot.
        await finished(registry, based.run.id)
        assert.equal(registry.stateOf(queued.run), "queued")

        await finished(registry, holder.run.id)
        await finished(registry, queued.run.id)
        assert.deepEqual(started, [queued.run.id])
        assert.ok(!argvOf("slow plain holder").includes("--base"))
        assert.ok(!argvOf("quick plain queued").includes("--base"))
    })
})

describe("IntegrationWorktree with a base ref", () => {
    it("branches from the base ref, not the advanced host HEAD, and never syncs the host", async () => {
        const { repo, mainSha, hostSha } = repoAheadOfMain()
        const runId = uniqueRunId("base-ref")
        cleanups.push(async () => {
            await removeWorktreeRun(repo, runId)
            rmSync(repo, { recursive: true, force: true })
        })
        const logs: string[] = []
        const worktree = new IntegrationWorktree({
            repoRoot: repo,
            gitGate: new GitGate(),
            runId,
            goalBranch: "baro/goal",
            push: false,
            baseRef: "main",
            onLog: (line) => logs.push(line),
        })

        const prepared = await worktree.prepare()
        assert.notEqual(mainSha, hostSha)
        assert.equal(prepared.baseSha, mainSha)
        assert.equal(git(repo, "rev-parse", "refs/heads/baro/goal"), mainSha)

        writeFileSync(join(worktree.integrationRoot, "c.txt"), "c\n")
        git(worktree.integrationRoot, "add", "-A")
        git(worktree.integrationRoot, "commit", "-m", "story")

        const result = await worktree.syncHostCheckout({ verified: true })
        assert.equal(result.kind, "untouched")
        assert.equal(result.kind === "untouched" && result.reason, "base_ref_run")
        assert.equal(git(repo, "rev-parse", "HEAD"), hostSha)
        assert.ok(logs.some((l) => l.includes("(base_ref_run)")), logs.join("\n"))
    })
})
