import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Finalizer } from "../../src/participants/finalizer.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import {
    FinalizeStarted,
    LevelStarted,
    PrCreated,
    RunCompleted,
    RunStarted,
    RunVerificationCompleted,
    StoryMergeFailed,
    StoryMerged,
    StoryResult,
    type RunVerificationCompletedData,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("Finalizer", () => {
    it("accepts lifecycle, repository, verifier, and story events only from bound authorities", async () => {
        await withTempDir("baro-finalizer-authority-", async (dir) => {
            const runId = "run-finalizer-authority"
            const coordinator = source("collective-board")
            const repository = source("repository")
            const verifier = source("verifier")
            const worker = source("S1")
            const attacker = source("S1")
            const outcomeAuthority = new StoryOutcomeAuthority(runId)
            const correlation = {
                runId,
                storyId: "S1",
                leaseId: "lease-1",
                generation: 1,
            }
            outcomeAuthority.registerResultAuthority(correlation, worker)

            const finalizer = new Finalizer({
                cwd: dir,
                prdPath: join(dir, "prd.json"),
                baseSha: "base-sha",
                createPr: false,
                runId,
                outcomeAuthority,
            })
            finalizer.setCoordinationAuthority(coordinator)
            finalizer.setRepositoryAuthority(repository)
            finalizer.setVerifierAuthority(verifier)
            const env = joinWithCapture(finalizer)
            const state = finalizer as unknown as {
                startedAtMs: number | null
                levels: Map<number, string[]>
                stories: Map<string, { success: boolean | null }>
                mergeFailed: Map<string, string>
                objectiveVerification: { runId: string } | null
                finalizePromise: Promise<void> | null
            }

            await finalizer.onExternalEvent(
                attacker,
                RunStarted.create({ project: "forged", storyCount: 99 }),
            )
            assert.equal(state.startedAtMs, null)
            await finalizer.onExternalEvent(
                coordinator,
                RunStarted.create({ project: "real", storyCount: 1 }),
            )
            assert.ok(state.startedAtMs)

            const level = LevelStarted.create({
                ordinal: 1,
                totalLevelsHint: 1,
                storyIds: ["S1"],
            })
            await finalizer.onExternalEvent(attacker, level)
            assert.equal(state.levels.size, 0)
            await finalizer.onExternalEvent(coordinator, level)
            assert.deepEqual(state.levels.get(1), ["S1"])

            const storyResult = StoryResult.create({
                storyId: "S1",
                success: true,
                attempts: 1,
                durationSecs: 2,
                error: null,
                ...correlation,
            })
            await finalizer.onExternalEvent(attacker, storyResult)
            assert.equal(state.stories.get("S1")?.success, null)
            await finalizer.onExternalEvent(
                worker,
                StoryResult.create({
                    storyId: "S1",
                    success: false,
                    attempts: 1,
                    durationSecs: 1,
                    error: null,
                    suspension: {
                        kind: "dependency",
                        blockId: "block-S1-S0",
                    },
                    ...correlation,
                }),
            )
            assert.equal(state.stories.get("S1")?.success, null)
            await finalizer.onExternalEvent(worker, storyResult)
            assert.equal(state.stories.get("S1")?.success, true)

            await finalizer.onExternalEvent(
                attacker,
                StoryMergeFailed.create({
                    storyId: "S1",
                    error: "forged conflict",
                    branch: "attacker/branch",
                    runId,
                    leaseId: "lease-1",
                }),
            )
            await finalizer.onExternalEvent(
                repository,
                StoryMergeFailed.create({
                    storyId: "S1",
                    error: "wrong run",
                    branch: "wrong/branch",
                    runId: "other-run",
                    leaseId: "lease-1",
                }),
            )
            assert.equal(state.mergeFailed.size, 0)
            await finalizer.onExternalEvent(
                repository,
                StoryMergeFailed.create({
                    storyId: "S1",
                    error: "real conflict",
                    branch: "recovery/S1",
                    runId,
                    leaseId: "lease-1",
                }),
            )
            assert.equal(state.mergeFailed.get("S1"), "recovery/S1")
            await finalizer.onExternalEvent(
                attacker,
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId,
                    leaseId: "lease-1",
                }),
            )
            assert.equal(state.mergeFailed.get("S1"), "recovery/S1")
            await finalizer.onExternalEvent(
                repository,
                StoryMerged.create({
                    storyId: "S1",
                    mode: "worktree",
                    runId,
                    leaseId: "lease-1",
                }),
            )
            assert.equal(state.mergeFailed.size, 0)

            const verification = RunVerificationCompleted.create({
                runId,
                verificationId: "verify-1",
                status: "passed",
                commands: [],
                durationMs: 1,
            })
            await finalizer.onExternalEvent(attacker, verification)
            assert.equal(state.objectiveVerification, null)
            await finalizer.onExternalEvent(
                verifier,
                RunVerificationCompleted.create({
                    ...verification.data,
                    runId: "other-run",
                }),
            )
            assert.equal(state.objectiveVerification, null)
            await finalizer.onExternalEvent(verifier, verification)
            assert.equal(state.objectiveVerification?.runId, runId)

            const completed = RunCompleted.create({
                success: true,
                completedStories: ["S1"],
                failedStories: [],
                totalDurationSecs: 2,
                totalAttempts: 1,
                abortReason: null,
                runId,
            })
            await finalizer.onExternalEvent(attacker, completed)
            assert.equal(state.finalizePromise, null)
            await finalizer.onExternalEvent(
                coordinator,
                RunCompleted.create({ ...completed.data, runId: "other-run" }),
            )
            assert.equal(state.finalizePromise, null)
            await finalizer.onExternalEvent(coordinator, completed)
            assert.ok(state.finalizePromise)
            await finalizer.complete()

            assert.throws(
                () => finalizer.setCoordinationAuthority(attacker),
                /already bound/,
            )
            assert.equal(env.events.some(FinalizeStarted.is), false)
        })
    })

    it("forgets a transient merge failure after recovery integrates the story", async () => {
        await withTempDir("baro-finalizer-recovery-", async (dir) => {
            const finalizer = new Finalizer({
                cwd: dir,
                prdPath: join(dir, "prd.json"),
                createPr: false,
            })
            await finalizer.onExternalEvent(
                source("git"),
                StoryMergeFailed.create({
                    storyId: "S1",
                    error: "conflict",
                    branch: "baro-recovery/run/S1/1",
                }),
            )
            await finalizer.onExternalEvent(
                source("git"),
                StoryMerged.create({ storyId: "S1", mode: "worktree" }),
            )

            const state = finalizer as unknown as {
                mergeFailed: Map<string, string>
            }
            assert.equal(state.mergeFailed.size, 0)
        })
    })

    it("emits a skipped PR result when the run did not succeed", async () => {
        await withTempDir("baro-finalizer-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    project: "Finalizer test",
                    branchName: "baro/finalizer-test",
                    description: "Exercise finalizer skip behavior",
                    userStories: [],
                }),
            )

            const logs: string[] = []
            const finalizer = new Finalizer({
                cwd: dir,
                prdPath,
                baseSha: "base-sha",
                onLog: (line) => logs.push(line),
            })
            const env = joinWithCapture(finalizer)

            await finalizer.onExternalEvent(
                source("conductor"),
                RunStarted.create({ project: "Finalizer test", storyCount: 1 }),
            )
            await finalizer.onExternalEvent(
                source("conductor"),
                RunCompleted.create({
                    success: false,
                    completedStories: [],
                    failedStories: ["S1"],
                    totalDurationSecs: 12,
                    totalAttempts: 2,
                    abortReason: "S1 failed",
                }),
            )
            await finalizer.complete()

            const event = env.events.find((e) => PrCreated.is(e))
            assert.ok(event, "PrCreated emitted for skipped PR")
            assert.deepEqual(event.data, {
                url: null,
                branch: "baro/finalizer-test",
                baseBranch: "main",
            })
            assert.ok(
                logs.some((line) => line.includes("run failed with no branch changes")),
                "skip reason logged",
            )
        })
    })

    it("does not emit PR lifecycle events when PR creation is disabled", async () => {
        await withTempDir("baro-finalizer-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    project: "Finalizer no PR test",
                    branchName: "baro/no-pr",
                    description: "Exercise createPr false behavior",
                    userStories: [],
                }),
            )

            const finalizer = new Finalizer({
                cwd: dir,
                prdPath,
                baseSha: "base-sha",
                createPr: false,
            })
            const env = joinWithCapture(finalizer)

            await finalizer.onExternalEvent(
                source("conductor"),
                RunStarted.create({ project: "Finalizer no PR test", storyCount: 0 }),
            )
            await finalizer.onExternalEvent(
                source("conductor"),
                RunCompleted.create({
                    success: true,
                    completedStories: [],
                    failedStories: [],
                    totalDurationSecs: 1,
                    totalAttempts: 0,
                    abortReason: null,
                }),
            )
            await finalizer.complete()

            assert.equal(env.events.some(FinalizeStarted.is), false)
            assert.equal(env.events.some(PrCreated.is), false)
        })
    })

    it("opens a PR through a fake gh binary and emits the created PR URL", async () => {
        await withTempDir("baro-finalizer-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    project: "Finalizer fake PR",
                    branchName: "baro/fake-pr",
                    description: "Exercise fake PR behavior",
                    userStories: [
                        {
                            id: "S1",
                            priority: 1,
                            title: "Ship finalizer test",
                            description: "Open a fake PR.",
                            dependsOn: [],
                            retries: 1,
                            acceptance: [],
                            tests: [],
                            passes: true,
                            completedAt: null,
                            durationSecs: 9,
                        },
                    ],
                }),
            )
            const binDir = join(dir, "bin")
            mkdirSync(binDir)
            const argsPath = join(dir, "gh-args.jsonl")
            const ghPath = join(binDir, "gh")
            writeFileSync(
                ghPath,
                [
                    "#!/usr/bin/env node",
                    "const { appendFileSync } = require('node:fs')",
                    "const args = process.argv.slice(2)",
                    "appendFileSync(process.env.GH_ARGS_LOG, JSON.stringify(args) + '\\n')",
                    "if (args[0] === '--version') { console.log('gh version 2.0.0'); process.exit(0) }",
                    "if (args[0] === 'repo' && args[1] === 'view') { console.log('main'); process.exit(0) }",
                    "if (args[0] === 'pr' && args[1] === 'create') { console.log('https://github.com/acme/baro/pull/123'); process.exit(0) }",
                    "console.error('unexpected gh args: ' + args.join(' '))",
                    "process.exit(1)",
                    "",
                ].join("\n"),
            )
            chmodSync(ghPath, 0o755)

            const originalPath = process.env.PATH
            const originalArgsLog = process.env.GH_ARGS_LOG
            process.env.PATH = `${binDir}:${originalPath ?? ""}`
            process.env.GH_ARGS_LOG = argsPath
            try {
                const finalizer = new Finalizer({
                    cwd: dir,
                    prdPath,
                    baseSha: "base-sha",
                })
                const env = joinWithCapture(finalizer)

                await finalizer.onExternalEvent(
                    source("conductor"),
                    RunStarted.create({ project: "Finalizer fake PR", storyCount: 1 }),
                )
                await finalizer.onExternalEvent(
                    source("conductor"),
                    LevelStarted.create({
                        ordinal: 1,
                        totalLevelsHint: 1,
                        storyIds: ["S1"],
                    }),
                )
                await finalizer.onExternalEvent(
                    source("S1"),
                    StoryResult.create({
                        storyId: "S1",
                        success: true,
                        attempts: 1,
                        durationSecs: 9,
                        error: null,
                    }),
                )
                await finalizer.onExternalEvent(
                    source("conductor"),
                    RunCompleted.create({
                        success: true,
                        completedStories: ["S1"],
                        failedStories: [],
                        totalDurationSecs: 9,
                        totalAttempts: 1,
                        abortReason: null,
                    }),
                )
                await finalizer.complete()

                assert.deepEqual(env.events.find(FinalizeStarted.is)?.data, {
                    branch: "baro/fake-pr",
                })
                assert.deepEqual(env.events.find(PrCreated.is)?.data, {
                    url: "https://github.com/acme/baro/pull/123",
                    branch: "baro/fake-pr",
                    baseBranch: "main",
                })

                const calls = readFileSync(argsPath, "utf8")
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line) as string[])
                const prCreate = calls.find(
                    (args) => args[0] === "pr" && args[1] === "create",
                )
                assert.ok(prCreate)
                assert.equal(prCreate[prCreate.indexOf("--base") + 1], "main")
                assert.equal(prCreate[prCreate.indexOf("--head") + 1], "baro/fake-pr")
                assert.equal(
                    prCreate[prCreate.indexOf("--title") + 1],
                    "Finalizer fake PR (1 story)",
                )
                const body = prCreate[prCreate.indexOf("--body") + 1]
                assert.match(body, /\| S1 \| Ship finalizer test \|/)
                assert.match(body, /Co-Authored-By: baro/)
            } finally {
                if (originalPath === undefined) {
                    delete process.env.PATH
                } else {
                    process.env.PATH = originalPath
                }
                if (originalArgsLog === undefined) {
                    delete process.env.GH_ARGS_LOG
                } else {
                    process.env.GH_ARGS_LOG = originalArgsLog
                }
            }
        })
    })

    // Runs the finalizer end-to-end through a fake gh binary while varying only
    // whether the merged branch's build/test verify passes, fails, or is absent.
    // Asserts the observable effect of `checkpoint`: the PR title's "Checkpoint:"
    // prefix and the verification block in the body.
    async function runFinalizerWithVerify(
        dir: string,
        pkgJson: Record<string, unknown> | null,
        runSuccess: boolean,
        objectiveVerification?: RunVerificationCompletedData,
        deliverVerificationEvent = true,
        completedVerification = objectiveVerification,
    ): Promise<{ title: string; body: string }> {
        const prdPath = join(dir, "prd.json")
        writeFileSync(
            prdPath,
            JSON.stringify({
                project: "Verify gate",
                branchName: "baro/verify",
                description: "Exercise the verify gate",
                userStories: [],
            }),
        )
        if (pkgJson) writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson))

        const binDir = join(dir, "bin")
        mkdirSync(binDir)
        const argsPath = join(dir, "gh-args.jsonl")
        const ghPath = join(binDir, "gh")
        writeFileSync(
            ghPath,
            [
                "#!/usr/bin/env node",
                "const { appendFileSync } = require('node:fs')",
                "const args = process.argv.slice(2)",
                "appendFileSync(process.env.GH_ARGS_LOG, JSON.stringify(args) + '\\n')",
                "if (args[0] === '--version') { console.log('gh version 2.0.0'); process.exit(0) }",
                "if (args[0] === 'repo' && args[1] === 'view') { console.log('main'); process.exit(0) }",
                "if (args[0] === 'pr' && args[1] === 'create') { console.log('https://github.com/acme/baro/pull/9'); process.exit(0) }",
                "process.exit(1)",
                "",
            ].join("\n"),
        )
        chmodSync(ghPath, 0o755)

        const originalPath = process.env.PATH
        const originalArgsLog = process.env.GH_ARGS_LOG
        process.env.PATH = `${binDir}:${originalPath ?? ""}`
        process.env.GH_ARGS_LOG = argsPath
        try {
            const finalizer = new Finalizer({ cwd: dir, prdPath, baseSha: "base-sha" })
            joinWithCapture(finalizer)
            await finalizer.onExternalEvent(
                source("conductor"),
                RunStarted.create({ project: "Verify gate", storyCount: 0 }),
            )
            if (objectiveVerification && deliverVerificationEvent) {
                await finalizer.onExternalEvent(
                    source("run-verifier"),
                    RunVerificationCompleted.create(objectiveVerification),
                )
            }
            await finalizer.onExternalEvent(
                source("conductor"),
                RunCompleted.create({
                    success: runSuccess,
                    completedStories: [],
                    failedStories: [],
                    totalDurationSecs: 1,
                    totalAttempts: 0,
                    abortReason: runSuccess ? null : "boom",
                    ...(completedVerification
                        ? {
                              runId: completedVerification.runId,
                              verificationStatus: completedVerification.status,
                              verification: {
                                  verificationId: completedVerification.verificationId,
                                  status: completedVerification.status,
                                  commands: completedVerification.commands,
                                  durationMs: completedVerification.durationMs,
                              },
                          }
                        : {}),
                }),
            )
            await finalizer.complete()

            const calls = readFileSync(argsPath, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as string[])
            const prCreate = calls.find((a) => a[0] === "pr" && a[1] === "create")
            assert.ok(prCreate, "gh pr create was called")
            return {
                title: prCreate[prCreate.indexOf("--title") + 1],
                body: prCreate[prCreate.indexOf("--body") + 1],
            }
        } finally {
            if (originalPath === undefined) delete process.env.PATH
            else process.env.PATH = originalPath
            if (originalArgsLog === undefined) delete process.env.GH_ARGS_LOG
            else process.env.GH_ARGS_LOG = originalArgsLog
        }
    }

    it("forces a checkpoint when verify runs and fails, surfacing the failure in the body", async () => {
        await withTempDir("baro-finalizer-", async (dir) => {
            const { title, body } = await runFinalizerWithVerify(
                dir,
                { name: "v", scripts: { test: "exit 3" } },
                true,
            )
            assert.match(title, /^Checkpoint:/)
            assert.match(body, /Build\/test verification failed/)
            assert.match(body, /npm run test/)
        })
    })

    it("stays a clean PR when verify did not run (no build/test scripts)", async () => {
        await withTempDir("baro-finalizer-", async (dir) => {
            const { title, body } = await runFinalizerWithVerify(
                dir,
                { name: "v", scripts: { lint: "true" } },
                true,
            )
            assert.doesNotMatch(title, /^Checkpoint:/)
            assert.doesNotMatch(body, /Build\/test verification failed/)
        })
    })

    it("reuses correlated collective evidence instead of rerunning a flaky gate", async () => {
        await withTempDir("baro-finalizer-", async (dir) => {
            const { title, body } = await runFinalizerWithVerify(
                dir,
                { name: "v", scripts: { test: "exit 3" } },
                true,
                {
                    runId: "run-verified",
                    verificationId: "verify-1",
                    status: "passed",
                    commands: [
                        {
                            command: "npm run test",
                            status: "passed",
                            durationMs: 12,
                        },
                    ],
                    durationMs: 12,
                },
            )

            assert.doesNotMatch(title, /^Checkpoint:/)
            assert.doesNotMatch(body, /Build\/test verification failed/)
        })
    })

    it("uses evidence embedded in RunCompleted if the standalone event arrives late", async () => {
        await withTempDir("baro-finalizer-", async (dir) => {
            const { title } = await runFinalizerWithVerify(
                dir,
                { name: "v", scripts: { test: "exit 3" } },
                true,
                {
                    runId: "run-verified",
                    verificationId: "verify-embedded",
                    status: "passed",
                    commands: [
                        {
                            command: "npm run test",
                            status: "passed",
                            durationMs: 9,
                        },
                    ],
                    durationMs: 9,
                },
                false,
            )

            assert.doesNotMatch(title, /^Checkpoint:/)
        })
    })

    it("prefers canonical completion evidence over a stale same-run cache entry", async () => {
        await withTempDir("baro-finalizer-", async (dir) => {
            const stalePassed: RunVerificationCompletedData = {
                runId: "run-same",
                verificationId: "verify-old",
                status: "passed",
                commands: [],
                durationMs: 1,
            }
            const canonicalFailed: RunVerificationCompletedData = {
                runId: "run-same",
                verificationId: "verify-timeout",
                status: "failed",
                commands: [
                    {
                        command: "baro run verifier",
                        status: "failed",
                        durationMs: 5,
                        tail: "verification timed out",
                    },
                ],
                durationMs: 5,
            }

            const { title, body } = await runFinalizerWithVerify(
                dir,
                { name: "v", scripts: { test: "exit 0" } },
                true,
                stalePassed,
                true,
                canonicalFailed,
            )

            assert.match(title, /^Checkpoint:/)
            assert.match(body, /Build\/test verification failed/)
            assert.match(body, /baro run verifier/)
        })
    })

    // A story passed but its merge-back conflicted, so its commits sit on a
    // preserved branch and the integration branch is empty. The finalizer must
    // recover that work (fast-forward the integration branch onto it) and open a
    // CHECKPOINT PR that names the conflict — never a clean PR-less "done".
    it("recovers a stranded merge-back branch into a checkpoint PR", async () => {
        await withTempDir("baro-finalizer-salvage-", async (dir) => {
            const git = (...args: string[]) =>
                execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
            git("init", "-q")
            git("config", "user.email", "t@baro.test")
            git("config", "user.name", "baro test")
            writeFileSync(join(dir, "README.md"), "base\n")
            git("add", "-A")
            git("commit", "-q", "-m", "base")
            const baseSha = git("rev-parse", "HEAD")
            // Integration branch stays at base (nothing merged onto it).
            git("checkout", "-q", "-b", "baro/salvage")
            // Preserved story branch: base + the story's un-merged commit.
            const storyBranch = "baro-wt/run-x/S1"
            git("checkout", "-q", "-b", storyBranch)
            writeFileSync(join(dir, "feature.txt"), "story work\n")
            git("add", "-A")
            git("commit", "-q", "-m", "S1 work")
            git("checkout", "-q", "baro/salvage")

            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    project: "Salvage",
                    branchName: "baro/salvage",
                    description: "Recover stranded work",
                    userStories: [
                        { id: "S1", priority: 1, title: "Add feature", description: "", dependsOn: [], retries: 1, acceptance: [], tests: [], passes: true, completedAt: null, durationSecs: 5 },
                    ],
                }),
            )
            const binDir = join(dir, "bin")
            mkdirSync(binDir)
            const argsPath = join(dir, "gh-args.jsonl")
            const ghPath = join(binDir, "gh")
            writeFileSync(
                ghPath,
                [
                    "#!/usr/bin/env node",
                    "const { appendFileSync } = require('node:fs')",
                    "const args = process.argv.slice(2)",
                    "appendFileSync(process.env.GH_ARGS_LOG, JSON.stringify(args) + '\\n')",
                    "if (args[0] === '--version') { console.log('gh version 2.0.0'); process.exit(0) }",
                    "if (args[0] === 'repo' && args[1] === 'view') { console.log('main'); process.exit(0) }",
                    "if (args[0] === 'pr' && args[1] === 'create') { console.log('https://github.com/acme/baro/pull/77'); process.exit(0) }",
                    "process.exit(1)",
                    "",
                ].join("\n"),
            )
            chmodSync(ghPath, 0o755)

            const originalPath = process.env.PATH
            const originalArgsLog = process.env.GH_ARGS_LOG
            process.env.PATH = `${binDir}:${originalPath ?? ""}`
            process.env.GH_ARGS_LOG = argsPath
            try {
                const finalizer = new Finalizer({ cwd: dir, prdPath, baseSha })
                const env = joinWithCapture(finalizer)

                await finalizer.onExternalEvent(source("conductor"), RunStarted.create({ project: "Salvage", storyCount: 1 }))
                await finalizer.onExternalEvent(source("conductor"), LevelStarted.create({ ordinal: 1, totalLevelsHint: 1, storyIds: ["S1"] }))
                await finalizer.onExternalEvent(source("S1"), StoryResult.create({ storyId: "S1", success: true, attempts: 1, durationSecs: 5, error: null }))
                await finalizer.onExternalEvent(source("git"), StoryMergeFailed.create({ storyId: "S1", error: "conflict", branch: storyBranch }))
                await finalizer.onExternalEvent(source("conductor"), RunCompleted.create({ success: true, completedStories: ["S1"], failedStories: [], totalDurationSecs: 5, totalAttempts: 1, abortReason: null }))
                await finalizer.complete()

                // A PR was opened (work not stranded) from the integration branch,
                // which was fast-forwarded onto the recovered commit.
                const pr = env.events.find(PrCreated.is)
                assert.equal(pr?.data.url, "https://github.com/acme/baro/pull/77")
                assert.equal(pr?.data.branch, "baro/salvage")
                assert.ok(existsSync(join(dir, "feature.txt")), "integration branch fast-forwarded onto the recovered commit")

                const calls = readFileSync(argsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[])
                const prCreate = calls.find((a) => a[0] === "pr" && a[1] === "create")!
                assert.equal(prCreate[prCreate.indexOf("--head") + 1], "baro/salvage")
                assert.match(prCreate[prCreate.indexOf("--title") + 1], /^Checkpoint:/)
                const body = prCreate[prCreate.indexOf("--body") + 1]
                assert.match(body, /Merge conflicts during integration/)
                assert.match(body, new RegExp(storyBranch))
            } finally {
                if (originalPath === undefined) delete process.env.PATH
                else process.env.PATH = originalPath
                if (originalArgsLog === undefined) delete process.env.GH_ARGS_LOG
                else process.env.GH_ARGS_LOG = originalArgsLog
            }
        })
    })
})
