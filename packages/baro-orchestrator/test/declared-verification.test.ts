import { existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    createVerifyPlan,
    MAX_DECLARED_VERIFY_COMMANDS,
    MAX_FINAL_ADDED_VERIFY_COMMANDS,
    mergeVerifyPlans,
    recommendedMergedVerifyTimeoutMs,
    verifyBuild,
} from "../src/verify.js"
import { readAuthoritativeDeclaredTests } from "../src/prd-declared-tests.js"
import { withTempDir } from "./participants/helpers.js"

describe("declared verification policy", () => {
    it("turns shell syntax into incomplete evidence without executing it", async () => {
        await withTempDir("baro-verify-declared-injection-", async (dir) => {
            const escapedMarker = join(dir, "escaped")
            writeFileSync(join(dir, "safe.js"), "export const safe = true\n")
            const plan = createVerifyPlan(dir, {
                declaredTests: [
                    {
                        storyId: "S1",
                        command: `node --check safe.js; touch ${escapedMarker}`,
                    },
                    {
                        storyId: "S2\u001b[31m",
                        command: "node --check safe.js\u001b[31m",
                    },
                ],
            })

            assert.equal(plan.commands.length, 2)
            assert.match(
                plan.commands[0]?.incompleteReason ?? "",
                /unsupported quoting, shell, or glob syntax/,
            )
            assert.equal(
                plan.commands.some((command) => command.label.includes("\u001b")),
                false,
            )
            const result = await verifyBuild(dir, { plan })
            assert.equal(result.ran, false)
            assert.equal(result.ok, true)
            assert.equal(result.commands[0]?.status, "skipped")
            assert.equal(existsSync(escapedMarker), false)
        })
    })

    it("preserves malformed raw PRD tests as incomplete requirements", async () => {
        await withTempDir("baro-verify-raw-prd-", async (dir) => {
            const prdPath = join(dir, "prd.json")
            writeFileSync(
                prdPath,
                JSON.stringify({
                    userStories: [
                        { id: "S1", tests: ["git diff --check", 42] },
                        { id: "S2" },
                        { id: "S3", tests: "npm test" },
                    ],
                }),
            )
            const requirements = readAuthoritativeDeclaredTests(prdPath)
            assert.equal(requirements.length, 4)
            assert.equal(requirements[0]?.command, "git diff --check")
            assert.match(requirements[1]?.declarationError ?? "", /must be a string/)
            assert.match(requirements[2]?.declarationError ?? "", /tests must be an array/)
            assert.match(requirements[3]?.declarationError ?? "", /tests must be an array/)

            const plan = createVerifyPlan(dir, { declaredTests: requirements })
            assert.equal(
                plan.commands.filter((command) => command.incompleteReason).length,
                3,
            )
        })
    })

    it(
        "contains node paths lexically and through symlinks",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-verify-declared-outside-", async (outside) => {
                const outsideFile = join(outside, "outside.js")
                writeFileSync(outsideFile, "export const outside = true\n")
                await withTempDir("baro-verify-declared-node-", async (dir) => {
                    writeFileSync(join(dir, "safe.js"), "export const safe = true\n")
                    writeFileSync(
                        join(dir, "safe.test.cjs"),
                        "require('node:test')('safe', () => {})\n",
                    )
                    symlinkSync(outsideFile, join(dir, "escaped.js"))
                    const plan = createVerifyPlan(dir, {
                        declaredTests: [
                            { storyId: "S1", command: "node --check safe.js" },
                            { storyId: "S2", command: "node --test safe.test.cjs" },
                            { storyId: "S3", command: "node --check ../outside.js" },
                            { storyId: "S4", command: "node --check escaped.js" },
                        ],
                    })

                    assert.equal(plan.commands[0]?.tool, "node")
                    assert.deepEqual(plan.commands[0]?.args, ["--check", "safe.js"])
                    assert.deepEqual(plan.commands[1]?.args, ["--test", "safe.test.cjs"])
                    assert.match(
                        plan.commands[2]?.incompleteReason ?? "",
                        /unsafe or escaping path/,
                    )
                    assert.match(
                        plan.commands[3]?.incompleteReason ?? "",
                        /outside repository/,
                    )
                    const result = await verifyBuild(dir, { plan })
                    assert.deepEqual(
                        result.commands.map(({ status }) => status),
                        ["passed", "passed", "skipped", "skipped"],
                    )
                })
            })
        },
    )

    it(
        "revalidates contained node paths immediately before execution",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-verify-node-swap-outside-", async (outside) => {
                const outsideFile = join(outside, "outside.js")
                writeFileSync(outsideFile, "export const outside = true\n")
                await withTempDir("baro-verify-node-swap-", async (dir) => {
                    const candidate = join(dir, "candidate.js")
                    writeFileSync(candidate, "export const safe = true\n")
                    const plan = createVerifyPlan(dir, {
                        declaredTests: [
                            { storyId: "S1", command: "node --check candidate.js" },
                        ],
                    })
                    unlinkSync(candidate)
                    symlinkSync(outsideFile, candidate)

                    const result = await verifyBuild(dir, { plan })
                    assert.equal(result.ran, false)
                    assert.equal(result.commands[0]?.status, "skipped")
                    assert.match(
                        result.commands[0]?.tail ?? "",
                        /immediate pre-spawn containment/,
                    )
                })
            })
        },
    )

    it(
        "revalidates package focused paths immediately before execution",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-verify-package-swap-outside-", async (outside) => {
                const outsideFile = join(outside, "focus.js")
                writeFileSync(outsideFile, "export const outside = true\n")
                await withTempDir("baro-verify-package-swap-", async (dir) => {
                    const candidate = join(dir, "focus.js")
                    writeFileSync(candidate, "export const safe = true\n")
                    writeFileSync(
                        join(dir, "package.json"),
                        JSON.stringify({
                            name: "v",
                            scripts: { test: "node -e \"process.exit(0)\"" },
                        }),
                    )
                    const plan = createVerifyPlan(dir, {
                        declaredTests: [
                            { storyId: "S1", command: "npm test -- focus.js" },
                        ],
                    })
                    unlinkSync(candidate)
                    symlinkSync(outsideFile, candidate)

                    const result = await verifyBuild(dir, { plan })
                    assert.deepEqual(
                        result.commands.map(({ status }) => status),
                        ["passed", "skipped"],
                    )
                    assert.match(
                        result.commands[1]?.tail ?? "",
                        /focused package path failed immediate pre-spawn containment/,
                    )
                })
            })
        },
    )

    it("rejects one-slash file URLs in package focused arguments", async () => {
        await withTempDir("baro-verify-package-file-url-outside-", async (outside) => {
            const outsideModule = join(outside, "payload.mjs")
            const outsideMarker = join(outside, "executed.marker")
            writeFileSync(
                outsideModule,
                `import { writeFileSync } from "node:fs";\n` +
                    `writeFileSync(${JSON.stringify(outsideMarker)}, "executed");\n`,
            )
            await withTempDir("baro-verify-package-file-url-", async (dir) => {
                writeFileSync(
                    join(dir, "package.json"),
                    JSON.stringify({
                        name: "v",
                        scripts: { test: "node --test" },
                    }),
                )
                const normalizedOutside = outsideModule.replace(/\\/g, "/")
                const fileUrl = `file:${normalizedOutside.startsWith("/") ? "" : "/"}${normalizedOutside}`
                const plan = createVerifyPlan(dir, {
                    declaredTests: [
                        {
                            storyId: "S1",
                            command: `npm test -- --import=${fileUrl}`,
                        },
                    ],
                })

                const declared = plan.commands.find((command) =>
                    command.label.startsWith("PRD test"))
                assert.match(
                    declared?.incompleteReason ?? "",
                    /unsafe or escaping value/,
                )

                const result = await verifyBuild(dir, { plan })
                assert.deepEqual(
                    result.commands.map(({ status }) => status),
                    ["passed", "skipped"],
                )
                assert.equal(existsSync(outsideMarker), false)
            })
        })
    })

    it("uses manager authority, preserves focused args, and rejects custom scripts", async () => {
        await withTempDir("baro-verify-declared-package-", async (dir) => {
            const exfiltrated = join(dir, "exfiltrated")
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    packageManager: "npm@10.9.0",
                    scripts: {
                        test: "node -e \"process.exit(0)\"",
                        lint: "exit 0",
                        exfiltrate:
                            `node -e "require('node:fs').writeFileSync(${JSON.stringify(exfiltrated)},'yes')"`,
                    },
                }),
            )
            const plan = createVerifyPlan(dir, {
                declaredTests: [
                    { storyId: "S1", command: "yarn run test -- foundation" },
                    { storyId: "S2", command: "npm test -- foundation" },
                    { storyId: "S3", command: "pnpm run test -- focused" },
                    { storyId: "S4", command: "npm run missing" },
                    { storyId: "S5", command: "npm run test -- --cwd=.." },
                    { storyId: "S6", command: "npm run exfiltrate" },
                    { storyId: "S7", command: "npm run missing" },
                ],
            })

            assert.deepEqual(
                plan.commands
                    .filter((command) => command.tool === "npm")
                    .map(({ label, args }) => ({ label, args })),
                [
                    { label: "npm run test", args: ["run", "test"] },
                    { label: "npm run lint", args: ["run", "lint"] },
                    {
                        label: "npm run test -- foundation",
                        args: ["run", "test", "--", "foundation"],
                    },
                    {
                        label: "npm run test -- focused",
                        args: ["run", "test", "--", "focused"],
                    },
                ],
            )
            assert.equal(
                plan.commands.filter((command) =>
                    command.label === "npm run test -- foundation").length,
                1,
            )
            assert.match(
                plan.commands.find((command) => command.label.includes("missing"))
                    ?.incompleteReason ?? "",
                /does not declare script 'missing'/,
            )
            assert.equal(
                plan.commands.filter((command) => command.label.includes("missing"))
                    .length,
                1,
            )
            assert.match(
                plan.commands.find((command) => command.label.includes("--cwd"))
                    ?.incompleteReason ?? "",
                /unsafe or escaping value/,
            )
            assert.match(
                plan.commands.find((command) => command.label.includes("exfiltrate"))
                    ?.incompleteReason ?? "",
                /custom package script 'exfiltrate' is not trusted/,
            )
            const result = await verifyBuild(dir, { plan })
            assert.equal(result.ok, true)
            assert.equal(
                result.commands.find((command) => command.command.includes("exfiltrate"))
                    ?.status,
                "skipped",
            )
            assert.equal(existsSync(exfiltrated), false)
        })
    })

    it(
        "rejects package context overrides, response files, and symlink escapes",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-verify-package-outside-", async (outside) => {
                writeFileSync(join(outside, "case.js"), "export const outside = true\n")
                await withTempDir("baro-verify-package-controls-", async (dir) => {
                    symlinkSync(outside, join(dir, "external"))
                    writeFileSync(
                        join(dir, "package.json"),
                        JSON.stringify({
                            name: "v",
                            scripts: { test: "node -e \"process.exit(0)\"" },
                        }),
                    )
                    const plan = createVerifyPlan(dir, {
                        declaredTests: [
                            { storyId: "S1", command: "npm test -- --prefix=fixtures" },
                            { storyId: "S2", command: "npm test -- --config-file=runner.js" },
                            { storyId: "S3", command: "npm test -- --filter=@response" },
                            { storyId: "S4", command: "npm test -- -Cfixtures" },
                            { storyId: "S5", command: "npm test -- external/case.js" },
                            { storyId: "S6", command: "npm test -- external/new-case.js" },
                            { storyId: "S7", command: "npm test -- external" },
                        ],
                    })

                    const declared = plan.commands.filter((command) =>
                        command.label.startsWith("PRD test"))
                    assert.equal(declared.length, 7)
                    assert.equal(
                        declared.every((command) => command.incompleteReason !== undefined),
                        true,
                    )
                    assert.match(
                        declared.at(-1)?.incompleteReason ?? "",
                        /unsafe or escaping value/,
                    )
                })
            })
        },
    )

    it("admits focused cargo tests but rejects command-context overrides", async () => {
        await withTempDir("baro-verify-declared-cargo-", async (dir) => {
            writeFileSync(join(dir, "Cargo.toml"), "[workspace]\nmembers = []\n")
            const plan = createVerifyPlan(dir, {
                declaredTests: [
                    {
                        storyId: "S1",
                        command: "cargo test -p baro-tui focused -- --exact",
                    },
                    { storyId: "S2", command: "cargo fmt --check" },
                    { storyId: "S3", command: "cargo clippy -- -D warnings" },
                    { storyId: "S4", command: "cargo test --manifest-path ../Cargo.toml" },
                    { storyId: "S5", command: "cargo test --config net.offline=true" },
                    { storyId: "S6", command: "cargo test -C ../outside" },
                    { storyId: "S7", command: "cargo test @response" },
                    {
                        storyId: "S8",
                        command: "cargo test --package=baro-tui focused -- --exact",
                    },
                ],
            })

            const focused = plan.commands.find((command) =>
                command.label.includes("focused"))
            assert.deepEqual(focused?.args, [
                "test",
                "--package",
                "baro-tui",
                "focused",
                "--",
                "--exact",
            ])
            assert.equal(
                plan.commands.filter((command) => command.label.includes("focused"))
                    .length,
                1,
            )
            assert.deepEqual(
                plan.commands.find((command) => command.label === "cargo fmt --check")
                    ?.args,
                ["fmt", "--check"],
            )
            assert.deepEqual(
                plan.commands.find((command) => command.label.includes("clippy"))
                    ?.args,
                ["clippy", "--", "-D", "warnings"],
            )
            for (const fragment of ["manifest-path", "--config", "-C", "@response"]) {
                assert.ok(
                    plan.commands.find((command) => command.label.includes(fragment))
                        ?.incompleteReason,
                    `${fragment} should be incomplete`,
                )
            }
        })
    })

    it("bounds runtime additions to the watchdog budget with incomplete evidence", async () => {
        await withTempDir("baro-verify-declared-budget-", async (dir) => {
            const baseline = createVerifyPlan(dir)
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { test: "exit 0" } }),
            )
            const final = createVerifyPlan(dir, {
                declaredTests: Array.from(
                    { length: MAX_DECLARED_VERIFY_COMMANDS },
                    (_unused, index) => ({
                        storyId: `S${index}`,
                        command: `npm test -- focus${index}`,
                    }),
                ),
            })
            const merged = mergeVerifyPlans(baseline, final)
            const executable = merged.commands.filter(
                (command) => !command.preflightFailure && !command.incompleteReason,
            )

            assert.equal(executable.length, MAX_FINAL_ADDED_VERIFY_COMMANDS)
            assert.match(
                merged.commands.at(-1)?.incompleteReason ?? "",
                /final command\(s\) were not executed/,
            )
            assert.equal(
                recommendedMergedVerifyTimeoutMs(baseline),
                (MAX_FINAL_ADDED_VERIFY_COMMANDS * 5 + 1) * 60_000 +
                    MAX_FINAL_ADDED_VERIFY_COMMANDS * 8_000,
            )
        })
    })
})
