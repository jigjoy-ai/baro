import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"

import { GitGate } from "../src/git.js"
import { StoryFactory } from "../src/participants/story-factory.js"
import type { StoryExecutor } from "../src/participants/story-executor.js"
import {
    RepositoryCommandError,
    runRepositoryCommand,
} from "../src/repository-command.js"
import { classifyStoryFailure } from "../src/provider-failure.js"
import { StoryOutcomeAuthority } from "../src/runtime/story-outcome-authority.js"
import {
    StorySpawnFailed,
    WorkLeaseGranted,
} from "../src/semantic-events.js"
import { WorktreeManager } from "../src/worktree.js"
import { joinWithCapture, source, withTempDir } from "./participants/helpers.js"

function writeCli(dir: string, name: string, source: string): string {
    const path = join(dir, name)
    writeFileSync(path, `#!/usr/bin/env node\n${source}`)
    chmodSync(path, 0o755)
    return path
}

function writeGitCli(dir: string, source: string): void {
    if (process.platform !== "win32") {
        writeCli(dir, "git", source)
        return
    }
    const modulePath = writeCli(dir, "fake-git.mjs", source)
    writeFileSync(
        join(dir, "git.cmd"),
        `@echo off\r\n"${process.execPath}" "${modulePath}" %*\r\n`,
    )
}

async function waitFor(
    predicate: () => boolean,
    label: string,
    timeoutMs = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`)
        await delay(10)
    }
}

async function within<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`test operation timed out after ${timeoutMs}ms`)),
                    timeoutMs,
                )
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

describe("repository command liveness", () => {
    it("retains command_timeout classification through rollback cause chains", () => {
        const repositoryTimeout = Object.assign(
            new Error("repository mutation timed out"),
            {
                name: "RepositoryCommandError",
                timedOut: true,
            },
        )
        const rollbackFailure = new Error("rollback also failed", {
            cause: repositoryTimeout,
        })

        assert.deepEqual(classifyStoryFailure(rollbackFailure), {
            kind: "infrastructure",
            code: "command_timeout",
        })
    })

    it("kills a TERM-resistant process tree before the caller releases GitGate", async () => {
        await withTempDir("baro-repository-command-", async (dir) => {
            const descendantStarted = join(dir, "descendant-started")
            const descendantEscaped = join(dir, "descendant-escaped")
            const cli = writeCli(
                dir,
                "fake-repository-command.mjs",
                `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const descendantSource = ${JSON.stringify(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setTimeout(() => writeFileSync(process.env.BARO_TEST_ESCAPED, "yes"), 1_500);
setInterval(() => {}, 10_000);
`)};
const descendant = spawn(process.execPath, ["--input-type=module", "-e", descendantSource], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(process.env.BARO_TEST_STARTED, String(descendant.pid));
setInterval(() => {}, 10_000);
`,
            )
            const gate = new GitGate()
            const releaseFirst = await gate.acquire()
            let commandSettled = false
            const timedCommand = (async () => {
                try {
                    await runRepositoryCommand(cli, [], {
                        cwd: dir,
                        env: {
                            ...process.env,
                            BARO_TEST_STARTED: descendantStarted,
                            BARO_TEST_ESCAPED: descendantEscaped,
                        },
                        timeoutMs: 500,
                        terminationGraceMs: 50,
                    })
                } finally {
                    commandSettled = true
                    releaseFirst()
                }
            })()
            const contender = (async () => {
                const release = await gate.acquire()
                assert.equal(
                    commandSettled,
                    true,
                    "GitGate released before repository process-tree settlement",
                )
                return release
            })()

            await assert.rejects(
                within(timedCommand),
                (error: unknown) => {
                    assert.ok(error instanceof RepositoryCommandError)
                    assert.equal(error.timedOut, true)
                    assert.equal(error.killed, true)
                    assert.match(error.message, /timed out after 500ms/u)
                    return true
                },
            )
            const releaseSecond = await within(contender)
            releaseSecond()

            assert.equal(
                existsSync(descendantStarted),
                true,
                "fixture never created the descendant",
            )
            await delay(1_100)
            assert.equal(
                existsSync(descendantEscaped),
                false,
                "repository command descendant survived timeout settlement",
            )
        })
    })

    it("bounds stderr as well as stdout", async () => {
        await withTempDir("baro-repository-stderr-", async (dir) => {
            const cli = writeCli(
                dir,
                "fake-noisy-command.mjs",
                `
process.on("SIGTERM", () => {});
const chunk = "x".repeat(64 * 1_024);
const flood = () => {
    for (let index = 0; index < 16; index += 1) process.stderr.write(chunk);
    setImmediate(flood);
};
flood();
`,
            )

            await assert.rejects(
                within(
                    runRepositoryCommand(cli, [], {
                        cwd: dir,
                        timeoutMs: 5_000,
                        terminationGraceMs: 50,
                        maxBuffer: 256,
                    }),
                ),
                (error: unknown) => {
                    assert.ok(error instanceof RepositoryCommandError)
                    assert.equal(error.timedOut, false)
                    assert.match(error.message, /stderr exceeded maxBuffer/u)
                    return true
                },
            )
        })
    })

    it("turns a timed-out worktree create into StorySpawnFailed and releases the gate", async () => {
        await withTempDir("baro-worktree-timeout-", async (dir) => {
            const repo = join(dir, "repo")
            const bin = join(dir, "bin")
            mkdirSync(repo)
            mkdirSync(bin)
            writeGitCli(
                bin,
                `
const args = process.argv.slice(2);
if (args[0] === "rev-parse" && args[1] === "HEAD") {
    setInterval(() => {}, 10_000);
} else {
    process.exit(0);
}
`,
            )

            const previousPath = process.env.PATH
            const previousTimeout =
                process.env.BARO_REPOSITORY_COMMAND_TIMEOUT_SECS
            process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`
            // ManagedProcessTree performs a short post-close observation; the
            // seam must exceed that normal drain while remaining test-fast.
            process.env.BARO_REPOSITORY_COMMAND_TIMEOUT_SECS = "0.5"

            const gate = new GitGate()
            const manager = new WorktreeManager(repo, gate, "run-timeout", {
                allowSharedFallback: false,
                linkDepDirs: false,
            })
            try {
                const runId = "run-worktree-timeout"
                const broker = source("broker")
                const board = source("board")
                const outcomeAuthority = new StoryOutcomeAuthority(runId)
                const executor: StoryExecutor = {
                    start: () => assert.fail("executor launched after worktree timeout"),
                }
                const factory = new StoryFactory({
                    cwd: repo,
                    coordinationMode: "collective",
                    runId,
                    workerId: "worker-timeout",
                    leaseAuthority: broker,
                    offerAuthority: board,
                    outcomeAuthority,
                    worktrees: manager,
                    requireWorktree: true,
                    executor,
                })
                const env = joinWithCapture(factory)

                await factory.onExternalEvent(
                    broker,
                    WorkLeaseGranted.create({
                        runId,
                        offerId: "offer-timeout",
                        leaseId: "lease-timeout",
                        workerId: "worker-timeout",
                        generation: 1,
                        request: {
                            storyId: "S-timeout",
                            prompt: "Never launch after repository timeout",
                            model: "sonnet",
                            retries: 0,
                            timeoutSecs: 30,
                        },
                    }),
                )
                await waitFor(
                    () => env.events.some(StorySpawnFailed.is),
                    "terminal StorySpawnFailed",
                )

                const failure = env.events.find(StorySpawnFailed.is)
                assert.ok(failure)
                assert.equal(failure.data.leaseId, "lease-timeout")
                assert.match(
                    failure.data.error,
                    /repository command "git rev-parse" timed out/u,
                )
                assert.deepEqual(failure.data.failure, {
                    kind: "infrastructure",
                    code: "command_timeout",
                })
                assert.equal(
                    outcomeAuthority.matchesSpawnFailure(factory, failure.data),
                    true,
                )

                const release = await within(gate.acquire(), 2_000)
                release()
            } finally {
                if (previousPath === undefined) delete process.env.PATH
                else process.env.PATH = previousPath
                if (previousTimeout === undefined) {
                    delete process.env.BARO_REPOSITORY_COMMAND_TIMEOUT_SECS
                } else {
                    process.env.BARO_REPOSITORY_COMMAND_TIMEOUT_SECS =
                        previousTimeout
                }
            }
        })
    })
})
