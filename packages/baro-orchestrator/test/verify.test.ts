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

    it("drops a repaired baseline package-manager preflight failure", async () => {
        await withTempDir("baro-verify-repaired-pm-", async (dir) => {
            const pkgPath = join(dir, "package.json")
            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    packageManager: "bun@1.2.20",
                    scripts: { test: "exit 0" },
                }),
            )
            const baseline = createVerifyPlan(dir)
            assert.match(
                baseline.commands[0]?.preflightFailure ?? "",
                /unsupported packageManager 'bun@1\.2\.20'/,
            )

            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    packageManager: "npm@11.4.2",
                    scripts: { test: "exit 0" },
                }),
            )
            const merged = mergeVerifyPlans(baseline, createVerifyPlan(dir))

            assert.deepEqual(
                merged.commands.map(({ label, preflightFailure }) => ({
                    label,
                    preflightFailure,
                })),
                [{ label: "npm run test", preflightFailure: undefined }],
            )
            assert.deepEqual(merged.javascriptPackageManagers, [
                { manager: "npm", declaredVersion: "11.4.2" },
            ])

            const result = await verifyBuild(dir, { plan: merged })
            assert.equal(result.ran, true)
            assert.equal(result.ok, true)
        })
    })

    it("retains a final package-manager regression while freezing baseline gates", async () => {
        await withTempDir("baro-verify-final-pm-regression-", async (dir) => {
            const pkgPath = join(dir, "package.json")
            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    packageManager: "npm@11.4.2",
                    scripts: { test: "exit 0" },
                }),
            )
            const baseline = createVerifyPlan(dir)

            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    packageManager: "bun@1.2.20",
                    scripts: {},
                }),
            )
            const merged = mergeVerifyPlans(baseline, createVerifyPlan(dir))

            assert.equal(merged.commands[0]?.label, "npm run test")
            assert.equal(merged.commands[1]?.label, "resolve package manager bun")
            assert.match(
                merged.commands[1]?.preflightFailure ?? "",
                /unsupported packageManager 'bun@1\.2\.20'/,
            )

            const result = await verifyBuild(dir, { plan: merged })
            assert.equal(result.ran, true)
            assert.equal(result.ok, false)
            assert.equal(
                result.failures.some(({ tail }) =>
                    /unsupported packageManager 'bun@1\.2\.20'/.test(tail)),
                true,
            )
            assert.equal(
                result.commands.some(({ command }) =>
                    command === "resolve package manager bun"),
                true,
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

    it("keeps the baseline package manager authoritative when lockfiles drift", async () => {
        await withTempDir("baro-verify-pm-drift-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )
            writeFileSync(join(dir, "yarn.lock"), "")
            const baseline = createVerifyPlan(dir)

            writeFileSync(join(dir, "package-lock.json"), "{}")
            const final = createVerifyPlan(dir)
            const merged = mergeVerifyPlans(baseline, final)

            assert.equal(baseline.commands[0]?.label, "yarn run test")
            assert.equal(final.commands[0]?.label, "npm run test")
            assert.equal(merged.commands.length, 1)
            assert.equal(merged.commands[0]?.label, "yarn run test")
            assert.equal(merged.commands[0]?.tool, "yarn")
        })
    })

    it("uses the baseline manager for a final-added gate after package-manager drift", async () => {
        await withTempDir("baro-verify-new-gate-pm-drift-", async (dir) => {
            const pkgPath = join(dir, "package.json")
            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    scripts: { build: "exit 0" },
                }),
            )
            writeFileSync(join(dir, "package-lock.json"), "{}")
            const baseline = createVerifyPlan(dir)

            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    packageManager: "yarn@4.9.2",
                    scripts: { build: "exit 0", test: "exit 0" },
                }),
            )
            writeFileSync(join(dir, "yarn.lock"), "")
            const final = createVerifyPlan(dir)
            const merged = mergeVerifyPlans(baseline, final)

            assert.deepEqual(
                final.commands.map(({ label, tool }) => ({ label, tool })),
                [
                    { label: "yarn run build", tool: "corepack" },
                    { label: "yarn run test", tool: "corepack" },
                ],
            )
            assert.deepEqual(
                merged.commands.map(({ label, tool, args }) => ({ label, tool, args })),
                [
                    {
                        label: "npm run build",
                        tool: "npm",
                        args: ["run", "build"],
                    },
                    {
                        label: "npm run test",
                        tool: "npm",
                        args: ["run", "test"],
                    },
                ],
            )

            const result = await verifyBuild(dir, { plan: merged })
            assert.equal(result.ok, true)
            assert.deepEqual(
                result.commands.map(({ command, status }) => ({ command, status })),
                [
                    { command: "npm run build", status: "passed" },
                    { command: "npm run test", status: "passed" },
                ],
            )
        })
    })

    it("preserves baseline Corepack Yarn for a final-added gate", async () => {
        await withTempDir("baro-verify-corepack-new-gate-", async (dir) => {
            const pkgPath = join(dir, "package.json")
            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    packageManager: "yarn@4.9.2",
                    scripts: { build: "exit 0" },
                }),
            )
            const baseline = createVerifyPlan(dir)

            writeFileSync(
                pkgPath,
                JSON.stringify({
                    name: "v",
                    packageManager: "npm@11.4.2",
                    scripts: { build: "exit 0", test: "exit 0" },
                }),
            )
            writeFileSync(join(dir, "package-lock.json"), "{}")
            const merged = mergeVerifyPlans(baseline, createVerifyPlan(dir))

            assert.equal(merged.commands.length, 2)
            assert.equal(merged.commands[0]?.label, "yarn run build")
            assert.equal(merged.commands[0]?.tool, "corepack")
            assert.deepEqual(merged.commands[0]?.args, ["yarn", "run", "build"])
            assert.equal(merged.commands[1]?.label, "yarn run test")
            assert.equal(merged.commands[1]?.tool, "corepack")
            assert.deepEqual(merged.commands[1]?.args, ["yarn", "run", "test"])
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

    it("prefers npm deterministically when package-lock.json and yarn.lock coexist", async () => {
        await withTempDir("baro-verify-lock-conflict-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )
            writeFileSync(join(dir, "package-lock.json"), "{}")
            writeFileSync(join(dir, "yarn.lock"), "")

            const plan = createVerifyPlan(dir)

            assert.equal(plan.commands[0]?.label, "npm run test")
            assert.equal(plan.commands[0]?.tool, "npm")
        })
    })

    it("honours a valid packageManager field ahead of conflicting lockfiles", async () => {
        await withTempDir("baro-verify-declared-pm-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    packageManager: "yarn@4.9.2",
                    scripts: { test: "exit 0" },
                }),
            )
            writeFileSync(join(dir, "package-lock.json"), "{}")
            writeFileSync(join(dir, "pnpm-lock.yaml"), "")
            writeFileSync(join(dir, "yarn.lock"), "")

            const plan = createVerifyPlan(dir)

            assert.equal(plan.commands[0]?.label, "yarn run test")
            assert.equal(plan.commands[0]?.tool, "corepack")
            assert.deepEqual(plan.commands[0]?.args, ["yarn", "run", "test"])
        })
    })

    it("fails closed for a well-formed unsupported packageManager", async () => {
        await withTempDir("baro-verify-unsupported-pm-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    packageManager: "bun@1.2.20",
                    scripts: { test: "exit 0" },
                }),
            )

            const plan = createVerifyPlan(dir)
            assert.equal(plan.commands.length, 1)
            assert.equal(plan.commands[0]?.label, "resolve package manager bun")
            assert.equal(plan.commands[0]?.preflightFailure?.includes("bun@1.2.20"), true)

            const result = await verifyBuild(dir, { plan })
            assert.equal(result.ran, true)
            assert.equal(result.ok, false)
            assert.match(result.failures[0]?.tail ?? "", /unsupported packageManager 'bun@1\.2\.20'/)
            assert.equal(result.commands.some(({ command }) => command === "npm run test"), false)
        })
    })

    it("fails closed for a present malformed packageManager declaration", async () => {
        await withTempDir("baro-verify-invalid-pm-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    packageManager: "yarn",
                    scripts: { test: "exit 0" },
                }),
            )
            writeFileSync(join(dir, "package-lock.json"), "{}")
            writeFileSync(join(dir, "pnpm-lock.yaml"), "")
            writeFileSync(join(dir, "yarn.lock"), "")

            const plan = createVerifyPlan(dir)

            assert.equal(plan.commands.length, 1)
            assert.equal(plan.commands[0]?.label, "resolve package manager declaration")
            assert.match(
                plan.commands[0]?.preflightFailure ?? "",
                /malformed packageManager "yarn"/,
            )
            assert.equal(plan.javascriptPackageManagers?.length, 0)

            const result = await verifyBuild(dir, { plan })
            assert.equal(result.ran, true)
            assert.equal(result.ok, false)
            assert.equal(
                result.commands.some(({ command }) => command === "pnpm run test"),
                false,
            )
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
