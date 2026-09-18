import assert from "node:assert/strict"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

import { createVerifyPlan } from "../../src/verification/verify.js"
import { coalesceNodeTestScripts } from "../../src/verification/node-test-script.js"

const FIXTURE_CWD = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "fixtures",
    "node-test-script",
)

describe("coalesceNodeTestScripts via createVerifyPlan", () => {
    it("collapses two declared npm-run-test file groups sharing a file into one node --test invocation", () => {
        const plan = createVerifyPlan(FIXTURE_CWD, {
            declaredTests: [
                {
                    storyId: "S-1",
                    command: "npm run test -- test/a.test.ts test/shared.test.ts",
                },
                {
                    storyId: "S-2",
                    command: "npm run test -- test/shared.test.ts test/b.test.ts",
                },
            ],
        })

        const nodeTestCommands = plan.commands.filter(
            (command) => command.label === "node --test (test)",
        )
        assert.equal(nodeTestCommands.length, 1)
        const [command] = nodeTestCommands
        assert.equal(command!.tool, "node")
        assert.deepEqual(command!.args, [
            "--import",
            "tsx",
            "--test-concurrency=2",
            "--test",
            "test/a.test.ts",
            "test/b.test.ts",
            "test/shared.test.ts",
        ])

        // No leftover npm wrapper for the "test" script, whether the plain
        // detected run or either declared file group.
        const npmWrapped = plan.commands.filter(
            (cmd) => cmd.tool === "npm" && cmd.args[0] === "run" && cmd.args[1] === "test",
        )
        assert.equal(npmWrapped.length, 0)
    })
})

describe("coalesceNodeTestScripts", () => {
    it("leaves a non node --test script (e.g. vitest run) unchanged", () => {
        const commands = [
            { label: "npm run test", tool: "npm", args: ["run", "test"] },
        ]
        const result = coalesceNodeTestScripts(
            commands,
            () => ({ scripts: { test: "vitest run" } }),
        )
        assert.deepEqual(result, commands)
    })

    it("falls back to the script's own globs when no files were declared", () => {
        const commands = [
            { label: "npm run test", tool: "npm", args: ["run", "test"], cwd: "/repo" },
        ]
        const result = coalesceNodeTestScripts(
            commands,
            () => ({
                scripts: { test: 'node --import tsx --test "test/**/*.test.ts"' },
            }),
        )
        assert.equal(result.length, 1)
        assert.equal(result[0]!.label, "node --test (test)")
        assert.deepEqual(result[0]!.args, [
            "--import",
            "tsx",
            "--test",
            "test/**/*.test.ts",
        ])
        assert.equal(result[0]!.cwd, "/repo")
    })
})
