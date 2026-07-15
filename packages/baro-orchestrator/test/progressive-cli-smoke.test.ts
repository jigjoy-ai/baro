import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { PrdFile } from "../src/prd.js"
import { withTempDir } from "./participants/helpers.js"

describe("progressive planner process lane", () => {
    it("buffers immediate Rust-style lifecycle commands until PlanningFeed is ready", async () => {
        await withTempDir("progressive-cli-", (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    project: "progressive-cli",
                    branchName: "baro/progressive-cli",
                    description: "Exercise the child-process planning lane.",
                    userStories: [],
                }, null, 2) + "\n",
            )
            const runId = "run-progressive-cli"
            const planningId = "planning-progressive-cli"
            const input = [
                JSON.stringify({
                    type: "planning_open",
                    run_id: runId,
                    planning_id: planningId,
                }),
                JSON.stringify({
                    type: "plan_failed",
                    run_id: runId,
                    planning_id: planningId,
                    code: "smoke_test_stop",
                    reason: "intentional process-boundary stop",
                }),
                "",
            ].join("\n")
            const result = spawnSync(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    "scripts/cli.ts",
                    "--prd",
                    prdPath,
                    "--cwd",
                    dir,
                    "--coordination",
                    "collective",
                    "--progressive-planning",
                    planningId,
                    "--no-git",
                    "--no-tui-events",
                    "--no-librarian",
                    "--no-memory",
                    "--no-sentry",
                    "--no-surgeon",
                    "--no-supervisor",
                    "--intra-level-delay",
                    "0",
                ],
                {
                    cwd: process.cwd(),
                    input,
                    encoding: "utf8",
                    timeout: 15_000,
                    env: {
                        ...process.env,
                        BARO_RUN_ID: runId,
                    },
                },
            )

            assert.equal(result.signal, null, result.stderr)
            assert.equal(result.status, 1, result.stderr)
            assert.match(result.stderr, /progressive planning failed/)
            assert.match(result.stderr, /smoke_test_stop/)
            const saved = JSON.parse(readFileSync(prdPath, "utf8")) as PrdFile
            assert.equal(saved.runtimeGraph?.planning?.status, "failed")
            assert.match(
                saved.runtimeGraph?.planning?.terminalReason ?? "",
                /intentional process-boundary stop/,
            )
        })
    })
})
