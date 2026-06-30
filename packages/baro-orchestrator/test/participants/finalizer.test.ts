import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Finalizer } from "../../src/participants/finalizer.js"
import {
    FinalizeStarted,
    LevelStarted,
    PrCreated,
    RunCompleted,
    RunStarted,
    StoryResult,
} from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

describe("Finalizer", () => {
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
                baseBranch: "",
            })
            assert.ok(
                logs.some((line) => line.includes("run did not complete successfully")),
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
})
