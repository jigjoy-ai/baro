import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { AgenticEnvironment, Participant } from "@mozaik-ai/core"

import { orchestrate } from "../src/orchestrate.js"
import type {
    StoryExecution,
    StoryExecOpts,
    StoryExecutor,
} from "../src/participants/story-executor.js"
import type { PrdFile } from "../src/prd.js"
import type { StoryRoute } from "../src/routing.js"
import type { StorySpawnRequestData } from "../src/semantic-events.js"
import { withTempDir } from "./participants/helpers.js"

class NeverQuiescingExecutor implements StoryExecutor {
    readonly started: string[] = []
    aborts = 0

    supportsCooperativeSuspend(): boolean {
        return true
    }

    start(
        request: StorySpawnRequestData,
        _route: StoryRoute,
        cwd: string,
        _environment: AgenticEnvironment,
        options: StoryExecOpts,
    ): StoryExecution {
        this.started.push(request.storyId)
        const resultSource = {
            agentId: `never-quiescing:${request.storyId}`,
        } as Participant
        options.registerResultAuthority?.(resultSource)

        if (request.storyId === "S1") {
            writeFileSync(join(cwd, "partial.txt"), "valuable partial work\n")
            const collaboration = options.collaboration
            assert.ok(collaboration, "fixture requires the collaboration transport")
            setImmediate(() => {
                const outbox = join(collaboration.sessionDir, "outbox")
                mkdirSync(outbox, { recursive: true })
                writeFileSync(
                    join(outbox, "dependency-timeout.json"),
                    JSON.stringify({
                        leaseId: request.leaseId,
                        kind: "block",
                        blockId: "block-e2e-suspension-timeout",
                        requiredStoryIds: ["S2"],
                        reason: "S2 is a hard prerequisite discovered at runtime",
                    }),
                )
            })
        }

        return {
            abort: () => {
                this.aborts += 1
            },
            suspend: () => new Promise(() => {}),
            dispose: () => {},
        }
    }
}

describe("dependency suspension orchestration", () => {
    it("retains the exact live worktree when quiescence cannot be certified", async () => {
        await withTempDir("dependency-suspension-e2e-", async (dir) => {
            git(dir, ["init", "-b", "main"])
            git(dir, ["config", "user.name", "Suspension Test"])
            git(dir, ["config", "user.email", "suspension@test.invalid"])
            writeFileSync(join(dir, "README.md"), "base\n")
            git(dir, ["add", "README.md"])
            git(dir, ["commit", "-m", "base"])

            const runId = `dependency-timeout-${process.pid}-${Date.now()}`
            const worktreePath = join(tmpdir(), "baro-worktrees", runId, "S1")
            const branch = `baro-wt/${runId}/S1`
            const prdPath = join(dir, "prd.json")
            const auditPath = join(dir, "audit.jsonl")
            writeFileSync(prdPath, JSON.stringify(testPrd(), null, 2) + "\n")
            const executor = new NeverQuiescingExecutor()

            try {
                const result = await Promise.race([
                    orchestrate({
                        runId,
                        prdPath,
                        cwd: dir,
                        coordinationMode: "collective",
                        parallel: 1,
                        publishRemote: false,
                        withGit: true,
                        emitTuiEvents: false,
                        withLibrarian: false,
                        withMemory: false,
                        withSentry: false,
                        withCritic: false,
                        withSurgeon: false,
                        withSupervisor: false,
                        intraLevelDelaySecs: 0,
                        collectiveSuspensionTimeoutMs: 40,
                        collectiveShutdownQuiescenceTimeoutMs: 10,
                        executor,
                        auditLogPath: auditPath,
                    }),
                    new Promise<never>((_, reject) =>
                        setTimeout(
                            () => reject(new Error("suspension timeout run deadlocked")),
                            3_000,
                        ),
                    ),
                ])

                assert.equal(result.summary.success, false)
                assert.deepEqual(executor.started, ["S1"])
                assert.ok(executor.aborts >= 1)
                assert.equal(
                    readFileSync(join(worktreePath, "partial.txt"), "utf8"),
                    "valuable partial work\n",
                )
                assert.match(
                    git(dir, ["worktree", "list", "--porcelain"]),
                    new RegExp(escapeRegExp(worktreePath)),
                )

                const audit = readFileSync(auditPath, "utf8")
                assert.match(audit, /"type":"work_blocked"/)
                assert.match(audit, /"type":"work_block_accepted"/)
                assert.match(audit, /"type":"work_lease_expired"/)
                assert.doesNotMatch(audit, /"type":"work_suspended"/)
                assert.doesNotMatch(
                    audit,
                    /"reason":"dependency_blocked"/,
                    "an uncertified worker must not release its lease as suspended",
                )
            } finally {
                if (existsSync(worktreePath)) {
                    try {
                        git(dir, ["worktree", "remove", "--force", worktreePath])
                    } catch {
                        rmSync(worktreePath, { recursive: true, force: true })
                        try {
                            git(dir, ["worktree", "prune"])
                        } catch { /* best-effort fixture cleanup */ }
                    }
                }
                try {
                    git(dir, ["branch", "-D", branch])
                } catch { /* best-effort fixture cleanup */ }
                rmSync(join(tmpdir(), "baro-worktrees", runId), {
                    recursive: true,
                    force: true,
                })
            }
        })
    })
})

function testPrd(): PrdFile {
    return {
        project: "dependency-suspension-e2e",
        branchName: "baro/dependency-suspension-e2e",
        description: "Preserve partial work when suspension cannot prove quiescence.",
        userStories: [story("S1"), story("S2")],
    }
}

function story(id: string): PrdFile["userStories"][number] {
    return {
        id,
        priority: Number(id.slice(1)),
        title: id,
        description: `Implement ${id}`,
        dependsOn: [],
        retries: 1,
        acceptance: [`${id} works`],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
        model: "openai:test-model",
    }
}

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
