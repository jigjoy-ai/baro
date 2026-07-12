import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    createVerifyPlan,
    mergeVerifyPlans,
    recommendedVerifyTimeoutMs,
    verifyBuild,
} from "../src/verify.js"
import { withTempDir } from "./participants/helpers.js"

// Uses real `npm run <script>` so the gate is exercised end-to-end (no lockfile
// → npm is the detected package manager). Timeouts are generous, so these run in
// a couple of seconds each.

describe("verifyBuild", () => {
    it("returns {ran:true, ok:false} when a test that runs exits non-zero", async () => {
        await withTempDir("baro-verify-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { test: "exit 1" } }),
            )
            const r = await verifyBuild(dir)
            assert.equal(r.ran, true)
            assert.equal(r.ok, false)
            assert.equal(r.failures.length, 1)
            assert.match(r.failures[0].cmd, /npm run test/)
            assert.equal(r.commands[0]?.status, "failed")
        })
    })

    it("runs a declared lint gate even when build/test are absent", async () => {
        await withTempDir("baro-verify-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { lint: "true" } }),
            )
            const r = await verifyBuild(dir)
            assert.equal(r.ran, true)
            assert.equal(r.ok, true)
            assert.equal(r.failures.length, 0)
            assert.deepEqual(
                r.commands.map(({ command, status }) => ({ command, status })),
                [{ command: "npm run lint", status: "passed" }],
            )
        })
    })

    it("returns {ran:false} when there is no manifest at all", async () => {
        await withTempDir("baro-verify-", async (dir) => {
            const r = await verifyBuild(dir)
            assert.equal(r.ran, false)
            assert.equal(r.ok, true)
            assert.deepEqual(r.commands, [])
        })
    })

    it("returns {ran:true, ok:true} when build and test both pass", async () => {
        await withTempDir("baro-verify-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { build: "exit 0", test: "exit 0" } }),
            )
            const r = await verifyBuild(dir)
            assert.equal(r.ran, true)
            assert.equal(r.ok, true)
            assert.equal(r.failures.length, 0)
            assert.deepEqual(
                r.commands.map((command) => command.status),
                ["passed", "passed"],
            )
        })
    })

    it("runs typecheck and lint as deterministic final gates", async () => {
        await withTempDir("baro-verify-static-gates-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    scripts: {
                        typecheck: "exit 0",
                        lint: "exit 1",
                    },
                }),
            )

            const r = await verifyBuild(dir)

            assert.equal(r.ran, true)
            assert.equal(r.ok, false)
            assert.deepEqual(
                r.commands.map(({ command, status }) => ({ command, status })),
                [
                    { command: "npm run typecheck", status: "passed" },
                    { command: "npm run lint", status: "failed" },
                ],
            )
        })
    })

    it("verifies workspace package scripts when the monorepo root has none", async () => {
        await withTempDir("baro-verify-workspaces-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
            )
            const app = join(dir, "packages", "app")
            const library = join(dir, "packages", "library")
            mkdirSync(app, { recursive: true })
            mkdirSync(library, { recursive: true })
            writeFileSync(
                join(app, "package.json"),
                JSON.stringify({
                    name: "app",
                    scripts: { build: "node -e \"process.exit(0)\"" },
                }),
            )
            writeFileSync(
                join(library, "package.json"),
                JSON.stringify({
                    name: "library",
                    scripts: { test: "node -e \"process.exit(0)\"" },
                }),
            )

            const r = await verifyBuild(dir)

            assert.equal(r.ran, true)
            assert.equal(r.ok, true)
            assert.deepEqual(
                r.commands.map(({ command, status }) => ({ command, status })),
                [
                    { command: "npm run build (packages/app)", status: "passed" },
                    { command: "npm run test (packages/library)", status: "passed" },
                ],
            )
        })
    })

    it("uses a pre-run plan even if an agent later removes the test script", async () => {
        await withTempDir("baro-verify-snapshot-", async (dir) => {
            const pkgPath = join(dir, "package.json")
            writeFileSync(
                pkgPath,
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )
            const plan = createVerifyPlan(dir)
            writeFileSync(
                pkgPath,
                JSON.stringify({ name: "v", scripts: { lint: "exit 0" } }),
            )

            const r = await verifyBuild(dir, { plan })

            assert.equal(r.ran, true)
            assert.equal(r.ok, false)
            assert.match(r.failures[0]?.tail ?? "", /Missing script.*test/s)
        })
    })

    it("merges newly introduced final-gate commands with the pre-run plan", async () => {
        await withTempDir("baro-verify-final-plan-", async (dir) => {
            const pkgPath = join(dir, "package.json")
            writeFileSync(
                pkgPath,
                JSON.stringify({ name: "v", scripts: {} }),
            )
            const baseline = createVerifyPlan(dir)
            writeFileSync(
                pkgPath,
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )

            const plan = mergeVerifyPlans(baseline, createVerifyPlan(dir))
            const r = await verifyBuild(dir, { plan })

            assert.equal(r.ran, true)
            assert.equal(r.ok, true)
            assert.deepEqual(
                r.commands.map(({ command, status }) => ({ command, status })),
                [{ command: "npm run test", status: "passed" }],
            )
        })
    })

    it("deduplicates commands present in both verify-plan snapshots", async () => {
        await withTempDir("baro-verify-dedupe-plan-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )
            const plan = createVerifyPlan(dir)

            const merged = mergeVerifyPlans(plan, createVerifyPlan(dir))

            assert.equal(merged.commands.length, 1)
            assert.equal(merged.commands[0]?.label, "npm run test")
        })
    })

    it("fails with evidence when an existing package manifest is malformed", async () => {
        await withTempDir("baro-verify-malformed-", async (dir) => {
            writeFileSync(join(dir, "package.json"), "{not-json")

            const r = await verifyBuild(dir)

            assert.equal(r.ran, true)
            assert.equal(r.ok, false)
            assert.deepEqual(r.commands, [
                {
                    command: "parse package.json",
                    status: "failed",
                    durationMs: 0,
                    tail: "package.json is not valid JSON",
                },
            ])
        })
    })

    it("discovers packages declared by pnpm-workspace.yaml", async () => {
        await withTempDir("baro-verify-pnpm-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "root", private: true }),
            )
            writeFileSync(
                join(dir, "pnpm-workspace.yaml"),
                "packages:\n  - 'packages/*'\n",
            )
            const app = join(dir, "packages", "app")
            mkdirSync(app, { recursive: true })
            writeFileSync(
                join(app, "package.json"),
                JSON.stringify({ name: "app", scripts: { test: "exit 1" } }),
            )

            const plan = createVerifyPlan(dir)

            assert.equal(plan.commands.length, 1)
            assert.equal(plan.commands[0]?.label, "pnpm run test (packages/app)")
        })
    })

    it("fails closed for workspace patterns it cannot safely expand", async () => {
        await withTempDir("baro-verify-glob-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "root", workspaces: ["packages/**"] }),
            )

            const r = await verifyBuild(dir)

            assert.equal(r.ran, true)
            assert.equal(r.ok, false)
            assert.match(r.failures[0]?.tail ?? "", /unsupported workspace pattern/)
        })
    })

    it("derives a whole-run timeout from the snapshotted command count", async () => {
        await withTempDir("baro-verify-budget-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    scripts: { build: "exit 0", test: "exit 0" },
                }),
            )
            const plan = createVerifyPlan(dir)

            assert.equal(recommendedVerifyTimeoutMs(plan), 11 * 60_000)
        })
    })
})
