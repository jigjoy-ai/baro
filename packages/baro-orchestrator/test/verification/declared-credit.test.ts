import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    createVerifyPlan,
    MAX_DECLARED_VERIFY_COMMANDS,
    verifyBuild,
    type VerifyCommandResult,
} from "../../src/verification/verify.js"
import {
    revalidateContainedPaths,
    RUNNER_FLAGS,
    translateDeclaredTests,
} from "../../src/verification/declared-verification.js"
import { creditDeclaredRequirements } from "../../src/verification/declared-credit.js"
import { withTempDir } from "../execution/helpers.js"

const passed = (command: string): VerifyCommandResult => ({
    command,
    status: "passed",
    durationMs: 1,
})

describe("runner-flag allowlist", () => {
    it("lists node's own test flags as data", () => {
        for (const flag of [
            "--import",
            "--test",
            "--test-concurrency",
            "--test-reporter",
            "--test-name-pattern",
        ]) {
            assert.ok(
                RUNNER_FLAGS.node?.includes(flag),
                `${flag} must be allowlisted for node`,
            )
        }
    })

    it("admits `node --test --import tsx <file>` and survives the pre-spawn re-check", async () => {
        await withTempDir("baro-credit-runner-flags-", async (dir) => {
            mkdirSync(join(dir, "test"), { recursive: true })
            writeFileSync(join(dir, "test", "x.test.ts"), "export {}\n")
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )

            const [trailing, inline, concurrency, rejected] =
                translateDeclaredTests(
                    dir,
                    [
                        {
                            storyId: "S1",
                            command: "node --test --import tsx test/x.test.ts",
                        },
                        {
                            storyId: "S2",
                            command: "node --test --import=tsx test/x.test.ts",
                        },
                        {
                            storyId: "S3",
                            command:
                                "node --test --test-concurrency=2 test/x.test.ts",
                        },
                        {
                            storyId: "S4",
                            command:
                                "node --test --experimental-vm-modules test/x.test.ts",
                        },
                    ],
                    ["npm"],
                )

            assert.equal(trailing?.incompleteReason, undefined)
            assert.deepEqual(trailing?.args, [
                "--import",
                "tsx",
                "--test",
                "test/x.test.ts",
            ])
            // `<flag>=<value>` resolves to the same admitted command.
            assert.equal(inline?.incompleteReason, undefined)
            assert.deepEqual(inline?.args, trailing?.args)
            assert.equal(concurrency?.incompleteReason, undefined)
            assert.deepEqual(concurrency?.args, [
                "--test-concurrency",
                "2",
                "--test",
                "test/x.test.ts",
            ])
            // A flag absent from the runner's allowlist keeps today's rejection.
            assert.match(
                rejected?.incompleteReason ?? "",
                /unsafe or escaping path '--experimental-vm-modules'/,
            )

            assert.equal(
                revalidateContainedPaths(dir, trailing!.containedPaths!, "node"),
                null,
            )
            // The re-check applies the identical classification, so a flag that
            // reached the contained-path list is not re-read as a path.
            assert.equal(
                revalidateContainedPaths(
                    dir,
                    [{ path: "--import", requireFile: false }],
                    "node",
                ),
                null,
            )
            assert.match(
                revalidateContainedPaths(dir, [
                    { path: "--import", requireFile: false },
                ]) ?? "",
                /failed immediate pre-spawn containment/,
            )
        })
    })
})

describe("declared dedup before budgeting", () => {
    it("collapses 21 declared node test files into one invocation costing one budget unit", async () => {
        await withTempDir("baro-credit-dedup-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    // Not a `node --test` script, so only the declared node
                    // commands can coalesce.
                    scripts: { test: "exit 0" },
                }),
            )
            mkdirSync(join(dir, "test"), { recursive: true })
            mkdirSync(join(dir, "src"), { recursive: true })
            const files = Array.from(
                { length: 21 },
                (_unused, index) => `test/case-${index}.test.ts`,
            )
            for (const file of files) writeFileSync(join(dir, file), "export {}\n")
            // Exactly fills the default budget alongside the single coalesced
            // node invocation: 1 + 7 === MAX_DECLARED_VERIFY_COMMANDS.
            const scoped = Array.from(
                { length: MAX_DECLARED_VERIFY_COMMANDS - 1 },
                (_unused, index) => `src/module-${index}`,
            )
            for (const path of scoped) writeFileSync(join(dir, path), "")

            const plan = createVerifyPlan(dir, {
                declaredTests: [
                    ...files.map((file, index) => ({
                        storyId: `S${index}`,
                        command: `node --test --import tsx ${file}`,
                    })),
                    ...scoped.map((path, index) => ({
                        storyId: `T${index}`,
                        command: `npm run test -- ${path}`,
                    })),
                ],
            })

            const nodeTests = plan.commands.filter(
                (command) => command.tool === "node" && command.args.includes("--test"),
            )
            assert.equal(nodeTests.length, 1)
            assert.deepEqual(nodeTests[0]?.args, [
                "--import",
                "tsx",
                "--test",
                ...[...files].sort(),
            ])
            assert.equal(nodeTests[0]?.origin, "declared")
            assert.equal(
                plan.commands.some((command) => command.incompleteReason),
                false,
            )
            assert.equal(
                plan.commands.some((command) =>
                    command.label.includes("beyond bounded budget"),
                ),
                false,
            )
            // Had the 21 files each consumed a unit, none of these would have
            // been admitted against the same effective limit.
            for (const path of scoped) {
                assert.ok(
                    plan.commands.some((command) => command.args.includes(path)),
                    `${path} must still fit the budget`,
                )
            }
        })
    })
})

describe("creditDeclaredRequirements", () => {
    it("credits a file another passed command named in its argv", () => {
        const requirement = {
            storyId: "S1",
            command: "pytest test/unit/a.test.ts",
        }
        const { credited, uncovered } = creditDeclaredRequirements(
            [requirement],
            [passed("node --import tsx --test test/unit/a.test.ts")],
        )
        assert.deepEqual(uncovered, [])
        assert.deepEqual(credited, [
            {
                file: "test/unit/a.test.ts",
                creditedBy: "node --import tsx --test test/unit/a.test.ts",
            },
        ])
    })

    it("credits a file a whole-suite script whose cwd is an ancestor executed", () => {
        const requirement = {
            storyId: "S2",
            command: "vitest run packages/app/test/b.test.ts",
        }
        const { credited, uncovered } = creditDeclaredRequirements(
            [requirement],
            [passed("npm run test (packages/app)")],
        )
        assert.deepEqual(uncovered, [])
        assert.deepEqual(credited, [
            {
                file: "packages/app/test/b.test.ts",
                creditedBy: "npm run test (packages/app)",
            },
        ])
    })

    it("leaves a requirement uncovered when no passed command reaches it", () => {
        const requirement = {
            storyId: "S3",
            command: "vitest run packages/app/test/b.test.ts",
        }
        const { credited, uncovered } = creditDeclaredRequirements(
            [requirement],
            [
                passed("npm run test (packages/other)"),
                {
                    command: "npm run test (packages/app)",
                    status: "failed" as const,
                    durationMs: 1,
                },
            ],
        )
        assert.deepEqual(credited, [])
        assert.deepEqual(uncovered, [requirement])
    })
})

describe("verifyBuild declared-requirement crediting", () => {
    it("records a credited requirement instead of emitting its incompleteReason", async () => {
        await withTempDir("baro-credit-verify-", async (dir) => {
            mkdirSync(join(dir, "test"), { recursive: true })
            writeFileSync(join(dir, "test", "a.test.ts"), "export {}\n")
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )

            const [credited, orphan] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "pytest test/a.test.ts" },
                    { storyId: "S2", command: "pytest test/missing.test.ts" },
                ],
                ["npm"],
            )
            assert.ok(credited?.incompleteReason)
            assert.ok(orphan?.incompleteReason)

            const suite = {
                label: "node --import tsx --test test/a.test.ts",
                tool: "node",
                args: ["-e", ""],
            }
            const result = await verifyBuild(dir, {
                plan: { commands: [suite, credited!, orphan!] },
                refreshDependencies: false,
                emitActivity: () => {},
            })

            const creditedResult = result.commands.find(
                (command) => command.command === credited!.label,
            )
            assert.equal(creditedResult?.status, "passed")
            assert.match(
                creditedResult?.tail ?? "",
                /^credited: executed by node --import tsx --test test\/a\.test\.ts$/,
            )
            // Incomplete stays reserved for a requirement nothing executed.
            const orphanResult = result.commands.find(
                (command) => command.command === orphan!.label,
            )
            assert.equal(orphanResult?.status, "skipped")
            assert.equal(orphanResult?.tail, orphan!.incompleteReason)
        })
    })
})
