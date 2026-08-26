import {
    existsSync,
    mkdirSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import { isAbsolute, join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    createVerifyPlan,
    MAX_DECLARED_VERIFY_COMMANDS,
    MAX_FINAL_ADDED_VERIFY_COMMANDS,
    mergeVerifyPlans,
    recommendedMergedVerifyTimeoutMs,
    verifyBuild,
} from "../../src/verification/verify.js"
import {
    revalidateContainedPaths,
    translateDeclaredTests,
} from "../../src/verification/declared-verification.js"
import { readAuthoritativeDeclaredTests } from "../../src/verification/prd-declared-tests.js"
import { withTempDir } from "../execution/helpers.js"

describe("declared verification policy", () => {
    it("routes a declaration matching a trusted script body through that script", async () => {
        await withTempDir("baro-verify-script-alias-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "alias-repo",
                    scripts: { test: "node test.js" },
                }),
            )
            writeFileSync(join(dir, "test.js"), "console.log('ok')\n")
            const plan = createVerifyPlan(dir, {
                declaredTests: [
                    { storyId: "S1", command: "node test.js" },
                    { storyId: "S1", command: "node  test.js" },
                    // Not a trusted script body — still skipped, fail-closed.
                    { storyId: "S1", command: "node other.js" },
                ],
            })
            const incomplete = plan.commands.filter(
                (command) => command.incompleteReason !== undefined,
            )
            // Only the non-script declaration stays skipped; both spellings
            // of the trusted script body alias (and dedupe) into `run test`.
            assert.equal(incomplete.length, 1)
            assert.match(incomplete[0]?.incompleteReason ?? "", /node declarations/)
            assert.match(incomplete[0]?.label ?? "", /node other\.js/)
            assert.ok(
                plan.commands.some(
                    (command) =>
                        command.incompleteReason === undefined &&
                        command.args[0] === "run" &&
                        command.args[1] === "test",
                ),
            )
        })
    })

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

    it("scopes a package script to the workspace a selector names", async () => {
        await withTempDir("baro-verify-declared-workspace-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "root",
                    private: true,
                    workspaces: ["packages/*"],
                }),
            )
            mkdirSync(join(dir, "packages", "app"), { recursive: true })
            writeFileSync(
                join(dir, "packages", "app", "package.json"),
                JSON.stringify({
                    name: "@baro/app",
                    scripts: {
                        typecheck: "tsc --noEmit",
                        test: "rstest run",
                        release: "do-it",
                    },
                }),
            )
            const workspace = join(dir, "packages", "app")
            const [byName, byPath, byEquals, focused] = translateDeclaredTests(
                dir,
                [
                    {
                        storyId: "S1",
                        command: "npm run typecheck -w @baro/app",
                    },
                    {
                        storyId: "S1",
                        command: "npm run typecheck --workspace packages/app",
                    },
                    {
                        storyId: "S1",
                        command: "npm run typecheck --workspace=@baro/app",
                    },
                    {
                        storyId: "S1",
                        command: "npm run test -w @baro/app -- tests/a.test.ts",
                    },
                ],
                [{ manager: "npm" }, { manager: "npm", cwd: workspace }],
            )

            // The root manifest declares no scripts at all, so every one of
            // these resolves only because the lookup moved to the workspace.
            for (const spec of [byName, byPath, byEquals]) {
                assert.equal(spec?.incompleteReason, undefined)
                assert.equal(spec?.tool, "npm")
                assert.deepEqual(spec?.args, ["run", "typecheck"])
                assert.equal(spec?.cwd, workspace)
            }
            // The selector keeps its declared spelling in the label but never
            // reaches argv, which would double-scope the manager.
            assert.equal(byName?.label, "npm run typecheck -w @baro/app")
            assert.equal(
                byPath?.label,
                "npm run typecheck --workspace packages/app",
            )
            assert.equal(
                byEquals?.label,
                "npm run typecheck --workspace=@baro/app",
            )

            assert.equal(focused?.incompleteReason, undefined)
            assert.deepEqual(focused?.args, [
                "run",
                "test",
                "--",
                "tests/a.test.ts",
            ])
            assert.equal(focused?.cwd, workspace)
            assert.equal(
                focused?.label,
                "npm run test -w @baro/app -- tests/a.test.ts",
            )
            assert.deepEqual(focused?.containedPaths, [
                {
                    path: "tests/a.test.ts",
                    requireFile: false,
                    allowMissing: true,
                },
            ])
        })
    })

    it("rejects every workspace selector the plan or manifest cannot license", async () => {
        await withTempDir("baro-verify-declared-workspace-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "root",
                    private: true,
                    workspaces: ["packages/*"],
                }),
            )
            mkdirSync(join(dir, "packages", "app"), { recursive: true })
            writeFileSync(
                join(dir, "packages", "app", "package.json"),
                JSON.stringify({
                    name: "@baro/app",
                    scripts: { typecheck: "tsc --noEmit", release: "do-it" },
                }),
            )
            mkdirSync(join(dir, "packages", "broken"), { recursive: true })
            const managers = [
                { manager: "npm" as const },
                { manager: "npm" as const, cwd: join(dir, "packages", "app") },
                {
                    manager: "npm" as const,
                    cwd: join(dir, "packages", "broken"),
                },
            ]
            const [
                unknown,
                twoSelectors,
                afterSeparator,
                noValue,
                untrusted,
                noScript,
                brokenManifest,
                glob,
            ] = translateDeclaredTests(
                dir,
                [
                    {
                        storyId: "S1",
                        command: "npm run typecheck -w @baro/missing",
                    },
                    {
                        storyId: "S1",
                        command:
                            "npm run typecheck -w @baro/app --workspace=packages/app",
                    },
                    { storyId: "S1", command: "npm run test -- -w @baro/app" },
                    { storyId: "S1", command: "npm run typecheck -w" },
                    { storyId: "S1", command: "npm run release -w @baro/app" },
                    { storyId: "S1", command: "npm run lint -w @baro/app" },
                    {
                        storyId: "S1",
                        command:
                            "npm run typecheck --workspace packages/broken",
                    },
                    { storyId: "S1", command: "npm run typecheck -w packages/*" },
                ],
                managers,
            )

            assert.equal(
                unknown?.incompleteReason,
                "unknown workspace '@baro/missing': known workspaces are packages/app, packages/broken",
            )
            assert.equal(
                twoSelectors?.incompleteReason,
                "package tests accept at most one workspace selector",
            )
            assert.equal(
                afterSeparator?.incompleteReason,
                "workspace selector must appear before '--'",
            )
            assert.equal(
                noValue?.incompleteReason,
                "workspace selector requires a name",
            )
            assert.equal(
                untrusted?.incompleteReason,
                "custom package script 'release' is not trusted by the baseline verifier policy",
            )
            assert.equal(
                noScript?.incompleteReason,
                "workspace '@baro/app' package.json does not declare script 'lint'",
            )
            assert.equal(
                brokenManifest?.incompleteReason,
                "declared package test requires a valid package.json in workspace 'packages/broken'",
            )
            // A '*' never reaches workspace resolution: the tokenizer refuses
            // glob syntax outright, so no pattern is ever expanded.
            assert.equal(
                glob?.incompleteReason,
                "declared test contains unsupported quoting, shell, or glob syntax",
            )

            // A rejection is evidence, never a runnable command.
            for (const spec of [unknown, twoSelectors, afterSeparator]) {
                assert.equal(spec?.tool, "node")
                assert.deepEqual(spec?.args, [])
            }
        })
    })

    it("accepts a workspace selector positioned between run and the script name", async () => {
        await withTempDir("baro-verify-declared-workspace-preselect-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "root",
                    private: true,
                    workspaces: ["packages/*"],
                }),
            )
            mkdirSync(join(dir, "packages", "pkg"), { recursive: true })
            writeFileSync(
                join(dir, "packages", "pkg", "package.json"),
                JSON.stringify({
                    name: "pkg",
                    scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
                }),
            )
            const workspace = join(dir, "packages", "pkg")
            const managers = [
                { manager: "npm" as const },
                { manager: "npm" as const, cwd: workspace },
            ]
            const [
                shortFlag,
                longFlag,
                longFlagEquals,
                focused,
                trailingRegression,
                testOperation,
            ] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "npm run -w pkg typecheck" },
                    {
                        storyId: "S1",
                        command: "npm run --workspace pkg typecheck",
                    },
                    {
                        storyId: "S1",
                        command: "npm run --workspace=pkg typecheck",
                    },
                    {
                        storyId: "S1",
                        command: "npm run -w pkg typecheck -- test/x.test.ts",
                    },
                    { storyId: "S1", command: "npm run typecheck -w pkg" },
                    { storyId: "S1", command: "npm test -w pkg" },
                ],
                managers,
            )

            // Pre-script, long-flag, and trailing-script selector positions
            // must all emit byte-identical argv; the selector never reaches
            // argv regardless of where it was declared.
            for (
                const spec of [shortFlag, longFlag, longFlagEquals, trailingRegression]
            ) {
                assert.equal(spec?.incompleteReason, undefined)
                assert.equal(spec?.tool, "npm")
                assert.deepEqual(spec?.args, ["run", "typecheck"])
                assert.equal(spec?.cwd, workspace)
            }

            assert.equal(focused?.incompleteReason, undefined)
            assert.equal(focused?.tool, "npm")
            assert.deepEqual(focused?.args, [
                "run",
                "typecheck",
                "--",
                "test/x.test.ts",
            ])
            assert.equal(focused?.cwd, workspace)

            // `npm test -w pkg` regression: the `test` operation's selector
            // handling is untouched by the `run` reordering.
            assert.equal(testOperation?.incompleteReason, undefined)
            assert.equal(testOperation?.tool, "npm")
            assert.deepEqual(testOperation?.args, ["run", "test"])
            assert.equal(testOperation?.cwd, workspace)
        })
    })

    it("rejects malformed workspace selectors positioned before the script name", async () => {
        await withTempDir(
            "baro-verify-declared-workspace-preselect-reject-",
            async (dir) => {
                const managers = [{ manager: "npm" as const }]
                const [duplicate, requiresName, missingScript, postSeparator] =
                    translateDeclaredTests(
                        dir,
                        [
                            {
                                storyId: "S1",
                                command: "npm run -w pkg typecheck -w pkg2",
                            },
                            { storyId: "S1", command: "npm run -w -- typecheck" },
                            { storyId: "S1", command: "npm run -w typecheck" },
                            {
                                storyId: "S1",
                                command: "npm run typecheck -- -w pkg",
                            },
                        ],
                        managers,
                    )
                assert.equal(
                    duplicate?.incompleteReason,
                    "package tests accept at most one workspace selector",
                )
                assert.equal(
                    requiresName?.incompleteReason,
                    "workspace selector requires a name",
                )
                // extractWorkspaceSelector (unmodified) greedily consumes the
                // sole remaining token as the workspace NAME here (it does not
                // start with '-'), leaving no script token rather than
                // tripping the selector's own "requires a name" check.
                assert.equal(
                    missingScript?.incompleteReason,
                    "package tests must use '<manager> test' or '<manager> run <script>'",
                )
                assert.equal(
                    postSeparator?.incompleteReason,
                    "workspace selector must appear before '--'",
                )
            },
        )
    })

    it("requires a root workspaces field before any selector resolves", async () => {
        await withTempDir("baro-verify-declared-workspace-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "root",
                    scripts: { typecheck: "tsc --noEmit" },
                }),
            )
            mkdirSync(join(dir, "packages", "app"), { recursive: true })
            writeFileSync(
                join(dir, "packages", "app", "package.json"),
                JSON.stringify({
                    name: "@baro/app",
                    scripts: { typecheck: "tsc --noEmit" },
                }),
            )
            const [spec] = translateDeclaredTests(
                dir,
                [{ storyId: "S1", command: "npm run typecheck -w @baro/app" }],
                [
                    { manager: "npm" },
                    { manager: "npm", cwd: join(dir, "packages", "app") },
                ],
            )
            // The root script exists and the workspace is resolvable, yet the
            // selector is still refused: the repo never declared workspaces.
            assert.equal(
                spec?.incompleteReason,
                "workspace selector requires a 'workspaces' field in the root package.json",
            )
        })
    })

    it("names no candidates when the plan resolved no workspace packages", async () => {
        await withTempDir("baro-verify-declared-workspace-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "root",
                    private: true,
                    workspaces: { packages: ["packages/*"] },
                    scripts: { typecheck: "tsc --noEmit" },
                }),
            )
            const [spec] = translateDeclaredTests(
                dir,
                [{ storyId: "S1", command: "npm run typecheck -w @baro/app" }],
                [{ manager: "npm" }],
            )
            assert.equal(
                spec?.incompleteReason,
                "unknown workspace '@baro/app': no workspace packages were resolved",
            )
        })
    })

    it("leaves selector-free package declarations byte-identical", async () => {
        await withTempDir("baro-verify-declared-workspace-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "root",
                    private: true,
                    workspaces: ["packages/*"],
                    scripts: { test: "node -e \"process.exit(0)\"" },
                }),
            )
            mkdirSync(join(dir, "packages", "app"), { recursive: true })
            writeFileSync(
                join(dir, "packages", "app", "package.json"),
                JSON.stringify({ name: "@baro/app", scripts: { test: "x" } }),
            )
            const [plain, focused] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "npm run test" },
                    { storyId: "S1", command: "npm run test -- --filter x" },
                ],
                [
                    { manager: "npm" },
                    { manager: "npm", cwd: join(dir, "packages", "app") },
                ],
            )

            // Merely having workspaces available changes nothing without a
            // selector: the root authority still owns the command.
            assert.equal(plain?.incompleteReason, undefined)
            assert.equal(plain?.cwd, undefined)
            assert.equal(plain?.label, "npm run test")
            assert.equal(plain?.tool, "npm")
            assert.deepEqual(plain?.args, ["run", "test"])
            assert.equal(plain?.containedPaths, undefined)

            assert.equal(focused?.incompleteReason, undefined)
            assert.equal(focused?.cwd, undefined)
            assert.equal(focused?.label, "npm run test -- --filter x")
            assert.deepEqual(focused?.args, [
                "run",
                "test",
                "--",
                "--filter",
                "x",
            ])
        })
    })

    it("subsumes path-scoped runs under the full suite instead of failing the budget", async () => {
        // A 12-story plan went fully green and was stamped failed: its
        // stories' `npm run test -- <path>` requirements overflowed the
        // bounded budget AFTER the automatic full `npm run test` had passed.
        await withTempDir("baro-verify-subsume-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    scripts: { build: "exit 0", test: "exit 0", lint: "exit 0" },
                }),
            )
            const plan = createVerifyPlan(dir, {
                declaredTests: Array.from(
                    { length: MAX_DECLARED_VERIFY_COMMANDS * 2 },
                    (_unused, index) => ({
                        storyId: `S${index + 1}`,
                        command: `npm run test -- src/module-${index}`,
                    }),
                ),
            })
            assert.equal(
                plan.commands.some((command) =>
                    command.label.includes("beyond bounded budget"),
                ),
                false,
                "subsumed path-scoped runs must not trip the overflow",
            )
            // Below the budget scoped runs stay admitted as focused evidence.
            assert.equal(
                plan.commands.some((command) =>
                    command.args.includes("src/module-0"),
                ),
                true,
            )
        })
    })

    it("canonicalizes and batches A13-shaped npx rstest declarations", async () => {
        await withTempDir("baro-verify-rstest-batch-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    scripts: {
                        build: "exit 0",
                        typecheck: "exit 0",
                        test: "rstest run",
                        lint: "exit 0",
                    },
                }),
            )
            mkdirSync(join(dir, "tests"))
            const paths = Array.from(
                { length: MAX_DECLARED_VERIFY_COMMANDS + 1 },
                (_unused, index) => `tests/case-${index}.test.ts`,
            )
            for (const path of paths) {
                writeFileSync(join(dir, path), "export {}\n")
            }

            const plan = createVerifyPlan(dir, {
                declaredTests: [
                    ...paths.map((path, index) => ({
                        storyId: `S${index + 1}`,
                        command: `npx rstest run ${path}`,
                    })),
                    {
                        storyId: "S-duplicate",
                        command: `npx rstest run ${paths[0]}`,
                    },
                ],
            })

            assert.equal(
                plan.commands.some((command) => command.tool === "npx"),
                false,
            )
            assert.equal(
                plan.commands.some((command) => command.incompleteReason),
                false,
            )
            const focused = plan.commands.filter(
                (command) => command.canonicalDeclaredFocus === "rstest",
            )
            assert.equal(focused.length, 1)
            assert.equal(focused[0]?.tool, "npm")
            assert.deepEqual(focused[0]?.args, [
                "run",
                "test",
                "--",
                ...paths,
            ])
            assert.deepEqual(
                focused[0]?.containedPaths?.map(({ path }) => path),
                paths,
            )
            for (const script of ["build", "typecheck", "test", "lint"]) {
                assert.equal(
                    plan.commands.filter(
                        (command) => command.label === `npm run ${script}`,
                    ).length,
                    1,
                )
            }
        })
    })

    it("deduplicates before translation and chunks every safely admissible rstest path", async () => {
        await withTempDir("baro-verify-rstest-translation-budget-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    scripts: { test: "rstest run" },
                }),
            )
            mkdirSync(join(dir, "tests"))
            const paths = Array.from(
                { length: MAX_DECLARED_VERIFY_COMMANDS * 8 + 1 },
                (_unused, index) => `tests/case-${index}.test.ts`,
            )
            const repeated = Array.from({ length: 600 }, (_unused, index) => ({
                storyId: `duplicate-${index}`,
                command: `npx rstest run ${paths[0]}`,
            }))
            const plan = createVerifyPlan(dir, {
                declaredTests: [
                    ...repeated,
                    ...paths.map((path, index) => ({
                        storyId: `unique-${index}`,
                        command: `npx rstest run ${path}`,
                    })),
                ],
            })

            assert.equal(
                plan.commands.some((command) => command.incompleteReason),
                false,
            )
            const focused = plan.commands.filter(
                (command) => command.canonicalDeclaredFocus === "rstest",
            )
            assert.equal(focused.length, 2)
            assert.deepEqual(
                focused.flatMap((command) =>
                    command.containedPaths?.map(({ path }) => path) ?? []),
                paths,
            )
        })
    })

    it("rejects every non-exact npx alias and mismatched test script", async () => {
        await withTempDir("baro-verify-rstest-reject-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    scripts: { test: "node --test" },
                }),
            )
            mkdirSync(join(dir, "tests"))
            writeFileSync(join(dir, "tests/case.test.ts"), "export {}\n")
            const plan = createVerifyPlan(dir, {
                declaredTests: [
                    {
                        storyId: "S1",
                        command: "npx rstest run tests/case.test.ts",
                    },
                    {
                        storyId: "S2",
                        command: "npx vitest run tests/case.test.ts",
                    },
                    {
                        storyId: "S3",
                        command: "npx -y rstest run tests/case.test.ts",
                    },
                    {
                        storyId: "S4",
                        command: "npx rstest run ../case.test.ts",
                    },
                    {
                        storyId: "S5",
                        command: "npx rstest run --watch",
                    },
                    {
                        storyId: "S6",
                        command: "npx rstest@latest run tests/case.test.ts",
                    },
                    {
                        storyId: "S7",
                        command: "npx --package rstest run tests/case.test.ts",
                    },
                    {
                        storyId: "S8",
                        command: "npx rstest run tests/case.test.ts --config",
                    },
                ],
            })
            const declared = plan.commands.filter((command) =>
                command.label.startsWith("PRD test"))
            assert.equal(declared.length, 8)
            assert.equal(
                declared.every((command) => command.incompleteReason),
                true,
            )
            assert.equal(plan.commands.some(({ tool }) => tool === "npx"), false)

            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({
                    name: "v",
                    scripts: { test: "rstest\nrun" },
                }),
            )
            const multilineAlias = createVerifyPlan(dir, {
                declaredTests: [{
                    storyId: "S9",
                    command: "npx rstest run tests/case.test.ts",
                }],
            })
            assert.match(
                multilineAlias.commands.find((command) =>
                    command.label.startsWith("PRD test"))?.incompleteReason ?? "",
                /exactly 'rstest run'/,
            )
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

    it("unwraps paired quotes around declared node --test paths", async () => {
        await withTempDir("baro-verify-quoted-path-", async (dir) => {
            const first = "test/acceptance/turn-review.test.ts"
            const second = "test/verification/declared-verification.test.ts"
            mkdirSync(join(dir, "test", "acceptance"), { recursive: true })
            mkdirSync(join(dir, "test", "verification"), { recursive: true })
            writeFileSync(join(dir, first), "")
            writeFileSync(join(dir, second), "")
            const [double, single, both] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: `node --test "${first}"` },
                    { storyId: "S1", command: `node --test '${second}'` },
                    {
                        storyId: "S1",
                        command: `node --test "${first}" "${second}"`,
                    },
                ],
                ["npm"],
            )

            assert.equal(double?.incompleteReason, undefined)
            assert.deepEqual(double?.args, ["--test", first])
            assert.equal(single?.incompleteReason, undefined)
            assert.deepEqual(single?.args, ["--test", second])
            assert.equal(both?.incompleteReason, undefined)
            assert.deepEqual(both?.args, ["--test", first, second])
            assert.equal(both?.label, `node --test ${first} ${second}`)
        })
    })

    it("keeps rejecting unpaired, mid-token and unsafe quoting", async () => {
        await withTempDir("baro-verify-quoted-reject-", async (dir) => {
            const rejected =
                "declared test contains unsupported quoting, shell, or glob syntax"
            const path = "test/acceptance/turn-review.test.ts"
            const specs = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: `echo "a; rm -rf /"` },
                    { storyId: "S1", command: `node --test foo"bar` },
                    { storyId: "S1", command: `node --test "${path}` },
                    { storyId: "S1", command: `node --test ${path}"` },
                    { storyId: "S1", command: `node --test ""` },
                    { storyId: "S1", command: `node --test "'${path}'"` },
                ],
                ["npm"],
            )

            for (const spec of specs) {
                assert.equal(spec.incompleteReason, rejected)
                assert.deepEqual(spec.args, [])
            }
        })
    })

    it("gives a quoted token no capability its bare form lacks", async () => {
        await withTempDir("baro-verify-quoted-capability-", async (dir) => {
            const path = "test/acceptance/turn-review.test.ts"
            mkdirSync(join(dir, "test", "acceptance"), { recursive: true })
            writeFileSync(join(dir, path), "")
            const [spaced, quoted, bare, rejectedQuoted, rejectedBare] =
                translateDeclaredTests(
                    dir,
                    [
                        { storyId: "S1", command: `node --test "a b.test.ts"` },
                        {
                            storyId: "S1",
                            command: `node --import tsx --test "${path}"`,
                        },
                        {
                            storyId: "S1",
                            command: `node --import tsx --test ${path}`,
                        },
                        {
                            storyId: "S1",
                            command: `node --import "other" --test "${path}"`,
                        },
                        {
                            storyId: "S1",
                            command: `node --import other --test ${path}`,
                        },
                    ],
                    ["npm"],
                )

            // Whitespace splits before unwrapping, so a quoted space can never
            // be smuggled through as a single argument.
            assert.equal(
                spaced?.incompleteReason,
                "declared test contains unsupported quoting, shell, or glob syntax",
            )
            // Unwrapping only removes the quotes: the translator judges the
            // quoted spelling exactly as it judges the bare one — both for the
            // accepted '--import tsx' prefix and for a rejected loader value.
            assert.equal(quoted?.incompleteReason, bare?.incompleteReason)
            assert.deepEqual(quoted?.args, bare?.args)
            assert.equal(quoted?.label, bare?.label)
            assert.equal(
                rejectedQuoted?.incompleteReason,
                rejectedBare?.incompleteReason,
            )
            assert.match(
                rejectedQuoted?.incompleteReason ?? "",
                /node declarations are limited to/,
            )
        })
    })

    it("translates a literal '--import tsx' loader prefix", async () => {
        await withTempDir("baro-verify-tsx-loader-", async (dir) => {
            const first = "test/acceptance/turn-review.test.ts"
            const second = "test/verification/declared-verification.test.ts"
            writeFileSync(join(dir, "package.json"), "{}")
            mkdirSync(join(dir, "test", "acceptance"), { recursive: true })
            mkdirSync(join(dir, "test", "verification"), { recursive: true })
            writeFileSync(join(dir, first), "")
            writeFileSync(join(dir, second), "")
            const [single, both, check] = translateDeclaredTests(
                dir,
                [
                    {
                        storyId: "S1",
                        command: `node --import tsx --test ${first}`,
                    },
                    {
                        storyId: "S1",
                        command: `node --import tsx --test ${first} ${second}`,
                    },
                    {
                        storyId: "S1",
                        command: `node --import tsx --check ${first}`,
                    },
                ],
                ["npm"],
            )

            assert.equal(single?.incompleteReason, undefined)
            assert.equal(single?.tool, "node")
            assert.deepEqual(single?.args, ["--import", "tsx", "--test", first])
            assert.equal(single?.label, `node --import tsx --test ${first}`)
            // The loader tokens are argv only; they must never be revalidated
            // as repository paths before the spawn.
            assert.deepEqual(single?.containedPaths, [
                { path: first, requireFile: false },
            ])

            assert.equal(both?.incompleteReason, undefined)
            assert.deepEqual(both?.args, [
                "--import",
                "tsx",
                "--test",
                first,
                second,
            ])
            assert.equal(
                both?.label,
                `node --import tsx --test ${first} ${second}`,
            )
            assert.deepEqual(both?.containedPaths, [
                { path: first, requireFile: false },
                { path: second, requireFile: false },
            ])

            assert.equal(check?.incompleteReason, undefined)
            assert.deepEqual(check?.args, ["--import", "tsx", "--check", first])
            assert.equal(check?.label, `node --import tsx --check ${first}`)
            assert.deepEqual(check?.containedPaths, [
                { path: first, requireFile: true },
            ])
        })
    })

    it("rejects every loader form that is not exactly '--import tsx'", async () => {
        await withTempDir("baro-verify-tsx-loader-reject-", async (dir) => {
            const path = "test/acceptance/turn-review.test.ts"
            writeFileSync(join(dir, "package.json"), "{}")
            mkdirSync(join(dir, "test", "acceptance"), { recursive: true })
            writeFileSync(join(dir, path), "")
            const modeGate =
                "node declarations are limited to '--check <file>' or " +
                "'--test <contained paths>' (bare 'node <file>' only in " +
                "repositories without package.json)"
            const specs = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "node --import other --test x" },
                    {
                        storyId: "S1",
                        command: "node --import ./evil.mjs --test x",
                    },
                    { storyId: "S1", command: "node --import=tsx --test x" },
                    { storyId: "S1", command: "node --loader tsx --test x" },
                    { storyId: "S1", command: "node --require tsx --test x" },
                    {
                        storyId: "S1",
                        command: `node --import tsx --import tsx --test ${path}`,
                    },
                ],
                ["npm"],
            )

            for (const spec of specs) {
                assert.equal(spec.incompleteReason, modeGate)
                assert.deepEqual(spec.args, [])
            }
        })
    })

    it("leaves loaderless node declarations byte-identical", async () => {
        await withTempDir("baro-verify-no-loader-", async (dir) => {
            const path = "test/acceptance/turn-review.test.ts"
            writeFileSync(join(dir, "package.json"), "{}")
            mkdirSync(join(dir, "test", "acceptance"), { recursive: true })
            writeFileSync(join(dir, path), "")
            const [test, check, absolute, traversal, flag] =
                translateDeclaredTests(
                    dir,
                    [
                        { storyId: "S1", command: `node --test ${path}` },
                        { storyId: "S1", command: `node --check ${path}` },
                        { storyId: "S1", command: "node --test /etc/passwd" },
                        {
                            storyId: "S1",
                            command: "node --test ../outside.test.ts",
                        },
                        { storyId: "S1", command: "node --test --reporter" },
                    ],
                    ["npm"],
                )

            assert.equal(test?.incompleteReason, undefined)
            assert.deepEqual(test?.args, ["--test", path])
            assert.equal(test?.label, `node --test ${path}`)
            assert.equal(check?.incompleteReason, undefined)
            assert.deepEqual(check?.args, ["--check", path])
            assert.equal(check?.label, `node --check ${path}`)
            assert.match(
                absolute?.incompleteReason ?? "",
                /unsafe or escaping path '\/etc\/passwd'/,
            )
            assert.match(
                traversal?.incompleteReason ?? "",
                /unsafe or escaping path '\.\.\/outside\.test\.ts'/,
            )
            assert.match(
                flag?.incompleteReason ?? "",
                /unsafe or escaping path '--reporter'/,
            )
        })
    })

    it("keeps the greenfield bare-file allowance under the loader prefix", async () => {
        await withTempDir("baro-verify-greenfield-loader-", async (dir) => {
            writeFileSync(join(dir, "test.js"), "process.exit(0)")
            const [bare, loader] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "node test.js" },
                    { storyId: "S1", command: "node --import tsx test.js" },
                ],
                ["npm"],
            )

            assert.equal(bare?.incompleteReason, undefined)
            assert.deepEqual(bare?.args, ["test.js"])
            assert.equal(bare?.label, "node test.js")
            assert.deepEqual(bare?.containedPaths, [
                { path: "test.js", requireFile: true },
            ])

            assert.equal(loader?.incompleteReason, undefined)
            assert.deepEqual(loader?.args, ["--import", "tsx", "test.js"])
            assert.equal(loader?.label, "node --import tsx test.js")
            assert.deepEqual(loader?.containedPaths, [
                { path: "test.js", requireFile: true },
            ])
        })
    })

    it("translates composer scripts anchored to a root composer.json", async () => {
        await withTempDir("baro-verify-declared-composer-", async (dir) => {
            writeFileSync(
                join(dir, "composer.json"),
                JSON.stringify({
                    name: "acme/app",
                    scripts: {
                        test: "phpunit",
                        check: ["phpunit", "phpstan analyse"],
                        custom: "echo",
                    },
                }),
            )
            const [bare, viaRun, untrusted] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "composer test" },
                    { storyId: "S1", command: "composer run check" },
                    { storyId: "S1", command: "composer run custom" },
                ],
                [{ manager: "npm" }],
            )

            assert.equal(bare?.incompleteReason, undefined)
            assert.equal(bare?.label, "composer run test")
            assert.equal(bare?.tool, "composer")
            assert.deepEqual(bare?.args, ["run", "test"])
            assert.equal(bare?.containedPaths, undefined)
            assert.equal(bare?.cwd, undefined)
            assert.equal(bare?.canonicalDeclaredFocus, undefined)

            // An array script body is a legal Composer spelling.
            assert.equal(viaRun?.incompleteReason, undefined)
            assert.equal(viaRun?.label, "composer run check")
            assert.equal(viaRun?.tool, "composer")
            assert.deepEqual(viaRun?.args, ["run", "check"])
            assert.equal(viaRun?.containedPaths, undefined)

            assert.match(
                untrusted?.incompleteReason ?? "",
                /custom composer script 'custom' is not trusted by the baseline verifier policy/,
            )
            assert.deepEqual(untrusted?.args, [])
        })
    })

    it("canonicalises both composer spellings onto one command identity", async () => {
        await withTempDir("baro-verify-declared-composer-", async (dir) => {
            writeFileSync(
                join(dir, "composer.json"),
                JSON.stringify({ scripts: { check: "phpunit" } }),
            )
            const [bare, viaRun] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "composer check" },
                    { storyId: "S1", command: "composer run check" },
                ],
                [{ manager: "npm" }],
            )

            assert.deepEqual(bare?.args, viaRun?.args)
            assert.equal(bare?.tool, viaRun?.tool)
            assert.equal(bare?.label, viaRun?.label)
        })
    })

    it("rejects composer declarations the manifest or baseline does not license", async () => {
        await withTempDir("baro-verify-declared-composer-", async (dir) => {
            writeFileSync(
                join(dir, "composer.json"),
                JSON.stringify({ scripts: { test: "phpunit" } }),
            )
            const [trailing, undeclared, shape, runOnly, unsafeName] =
                translateDeclaredTests(
                    dir,
                    [
                        {
                            storyId: "S1",
                            command: "composer run test --filter x",
                        },
                        { storyId: "S1", command: "composer lint" },
                        { storyId: "S1", command: "composer" },
                        { storyId: "S1", command: "composer run" },
                        { storyId: "S1", command: "composer run a/b" },
                    ],
                    [{ manager: "npm" }],
                )

            assert.match(
                trailing?.incompleteReason ?? "",
                /composer tests must not pass arguments after the script name/,
            )
            assert.deepEqual(trailing?.args, [])
            assert.equal(trailing?.tool, "node")
            assert.match(
                undeclared?.incompleteReason ?? "",
                /composer\.json does not declare script 'lint'/,
            )
            assert.match(
                shape?.incompleteReason ?? "",
                /composer tests must use 'composer <script>' or 'composer run <script>'/,
            )
            assert.match(
                runOnly?.incompleteReason ?? "",
                /composer tests must use 'composer <script>' or 'composer run <script>'/,
            )
            // Passes SAFE_TOKEN but not SAFE_SCRIPT_NAME.
            assert.match(
                unsafeName?.incompleteReason ?? "",
                /unsafe composer script name 'a\/b'/,
            )
        })
    })

    it("requires a valid root composer.json before any composer script runs", async () => {
        await withTempDir("baro-verify-declared-composer-", async (dir) => {
            const [missing] = translateDeclaredTests(
                dir,
                [{ storyId: "S1", command: "composer test" }],
                [{ manager: "npm" }],
            )
            assert.match(
                missing?.incompleteReason ?? "",
                /declared composer test requires a valid root composer\.json/,
            )
            assert.deepEqual(missing?.args, [])

            // A present-but-unparseable manifest fails the same way, before
            // the script-declaration and trusted-baseline checks.
            writeFileSync(join(dir, "composer.json"), "{ not json")
            const [invalid] = translateDeclaredTests(
                dir,
                [{ storyId: "S1", command: "composer test" }],
                [{ manager: "npm" }],
            )
            assert.match(
                invalid?.incompleteReason ?? "",
                /declared composer test requires a valid root composer\.json/,
            )

            // A JSON array is valid JSON but not a manifest object.
            writeFileSync(join(dir, "composer.json"), "[]")
            const [notObject] = translateDeclaredTests(
                dir,
                [{ storyId: "S1", command: "composer test" }],
                [{ manager: "npm" }],
            )
            assert.match(
                notObject?.incompleteReason ?? "",
                /declared composer test requires a valid root composer\.json/,
            )
        })
    })

    it("translates contained vendor/bin/phpunit declarations", async () => {
        await withTempDir("baro-verify-declared-phpunit-", async (dir) => {
            mkdirSync(join(dir, "vendor", "bin"), { recursive: true })
            writeFileSync(join(dir, "vendor", "bin", "phpunit"), "")
            writeFileSync(join(dir, "phpunit.xml"), "")
            mkdirSync(join(dir, "tests", "Unit"), { recursive: true })
            writeFileSync(join(dir, "tests", "UnitTest.php"), "")
            const binary = join(dir, "vendor", "bin", "phpunit")
            const [plain, suite, config, path, combined] =
                translateDeclaredTests(
                    dir,
                    [
                        { storyId: "S1", command: "vendor/bin/phpunit" },
                        {
                            storyId: "S1",
                            command: "vendor/bin/phpunit --testsuite unit",
                        },
                        {
                            storyId: "S1",
                            command: "vendor/bin/phpunit -c phpunit.xml",
                        },
                        {
                            storyId: "S1",
                            command: "vendor/bin/phpunit tests/UnitTest.php",
                        },
                        {
                            storyId: "S1",
                            command:
                                "vendor/bin/phpunit -c phpunit.xml tests/Unit",
                        },
                    ],
                    [{ manager: "npm" }],
                )

            // The label and every path argument keep the declared relative
            // form while the spawn target is absolute (cross-spawn resolves a
            // relative command through PATH, not the command cwd).
            assert.equal(plain?.incompleteReason, undefined)
            assert.equal(plain?.label, "vendor/bin/phpunit")
            assert.equal(plain?.tool, binary)
            assert.deepEqual(plain?.args, [])
            assert.deepEqual(plain?.containedPaths, [
                { path: binary, requireFile: true },
            ])

            assert.equal(suite?.incompleteReason, undefined)
            assert.equal(suite?.tool, binary)
            assert.deepEqual(suite?.args, ["--testsuite", "unit"])
            assert.equal(suite?.label, "vendor/bin/phpunit --testsuite unit")
            assert.deepEqual(suite?.containedPaths, [
                { path: binary, requireFile: true },
            ])

            assert.equal(config?.incompleteReason, undefined)
            assert.deepEqual(config?.args, ["-c", "phpunit.xml"])
            assert.deepEqual(config?.containedPaths, [
                { path: binary, requireFile: true },
                { path: join(dir, "phpunit.xml"), requireFile: true },
            ])

            assert.equal(path?.incompleteReason, undefined)
            assert.deepEqual(path?.args, ["tests/UnitTest.php"])
            assert.deepEqual(path?.containedPaths, [
                { path: binary, requireFile: true },
                {
                    path: join(dir, "tests", "UnitTest.php"),
                    requireFile: false,
                },
            ])

            // Binary first, then each path argument in declaration order.
            assert.equal(combined?.incompleteReason, undefined)
            assert.deepEqual(combined?.args, ["-c", "phpunit.xml", "tests/Unit"])
            assert.deepEqual(combined?.containedPaths, [
                { path: binary, requireFile: true },
                { path: join(dir, "phpunit.xml"), requireFile: true },
                { path: join(dir, "tests", "Unit"), requireFile: false },
            ])
        })
    })

    it(
        "emits phpunit path arguments repo-relative and the tool host-absolute",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-verify-declared-phpunit-", async (dir) => {
                mkdirSync(join(dir, "vendor", "bin"), { recursive: true })
                writeFileSync(join(dir, "vendor", "bin", "phpunit"), "")
                writeFileSync(join(dir, "phpunit.xml"), "")
                mkdirSync(join(dir, "tests", "Unit"), { recursive: true })
                const [spec] = translateDeclaredTests(
                    dir,
                    [
                        {
                            storyId: "S1",
                            command:
                                "vendor/bin/phpunit -c phpunit.xml tests/Unit",
                        },
                    ],
                    [{ manager: "npm" }],
                )

                assert.equal(spec?.incompleteReason, undefined)
                assert.equal(
                    spec?.label,
                    "vendor/bin/phpunit -c phpunit.xml tests/Unit",
                )
                assert.equal(spec?.tool, join(dir, "vendor", "bin", "phpunit"))
                assert.deepEqual(spec?.args, [
                    "-c",
                    "phpunit.xml",
                    "tests/Unit",
                ])
                assert.ok(spec?.args.every((value) => !value.includes(dir)))
                // Only the emitted args go relative; containedPaths stay
                // host-absolute so pre-spawn revalidation is unaffected.
                assert.deepEqual(spec?.containedPaths, [
                    {
                        path: join(dir, "vendor", "bin", "phpunit"),
                        requireFile: true,
                    },
                    { path: join(dir, "phpunit.xml"), requireFile: true },
                    { path: join(dir, "tests", "Unit"), requireFile: false },
                ])
                assert.ok(
                    spec?.containedPaths?.every(({ path }) => isAbsolute(path)),
                )
            })
        },
    )

    it("keeps every phpunit path revalidatable immediately pre-spawn", async () => {
        await withTempDir("baro-verify-declared-phpunit-", async (dir) => {
            mkdirSync(join(dir, "vendor", "bin"), { recursive: true })
            writeFileSync(join(dir, "vendor", "bin", "phpunit"), "")
            writeFileSync(join(dir, "phpunit.xml"), "")
            mkdirSync(join(dir, "tests", "Unit"), { recursive: true })
            const [spec] = translateDeclaredTests(
                dir,
                [
                    {
                        storyId: "S1",
                        command: "vendor/bin/phpunit -c phpunit.xml tests/Unit",
                    },
                ],
                [{ manager: "npm" }],
            )

            // The absolute entries this route emits must survive pre-spawn
            // revalidation; a relative-only revalidator would reject them all
            // and silently downgrade every phpunit command to "skipped".
            assert.equal(spec?.incompleteReason, undefined)
            assert.ok(
                spec?.containedPaths?.every(({ path }) => isAbsolute(path)),
            )
            assert.equal(
                revalidateContainedPaths(dir, spec?.containedPaths ?? []),
                null,
            )

            // Accepting absolute entries grants no escape: one pointing
            // outside cwd is still rejected.
            assert.match(
                revalidateContainedPaths(dir, [
                    { path: join(dir, "..", "outside.php"), requireFile: true },
                ]) ?? "",
                /failed immediate pre-spawn containment/,
            )

            // A vanished contained path downgrades the command rather than
            // letting it spawn against a missing file.
            unlinkSync(join(dir, "phpunit.xml"))
            assert.match(
                revalidateContainedPaths(dir, spec?.containedPaths ?? []) ?? "",
                /failed immediate pre-spawn containment/,
            )
        })
    })

    it("rejects phpunit declarations that escape containment or use unsupported flags", async () => {
        await withTempDir("baro-verify-declared-phpunit-", async (dir) => {
            mkdirSync(join(dir, "vendor", "bin"), { recursive: true })
            writeFileSync(join(dir, "vendor", "bin", "phpunit"), "")
            const grammar =
                /phpunit arguments allow only --testsuite <name>, -c\/--configuration <file>, and contained test paths/
            const [
                escape,
                filter,
                joinedSuite,
                joinedConfig,
                separator,
                relative,
                bareName,
                phar,
                missingSuite,
                missingConfig,
            ] = translateDeclaredTests(
                dir,
                [
                    {
                        storyId: "S1",
                        command: "vendor/bin/phpunit ../outside.php",
                    },
                    { storyId: "S1", command: "vendor/bin/phpunit --filter x" },
                    {
                        storyId: "S1",
                        command: "vendor/bin/phpunit --testsuite=unit",
                    },
                    { storyId: "S1", command: "vendor/bin/phpunit -c=x" },
                    { storyId: "S1", command: "vendor/bin/phpunit --" },
                    { storyId: "S1", command: "./vendor/bin/phpunit" },
                    { storyId: "S1", command: "phpunit" },
                    { storyId: "S1", command: "vendor/bin/phpunit.phar" },
                    {
                        storyId: "S1",
                        command: "vendor/bin/phpunit --testsuite",
                    },
                    { storyId: "S1", command: "vendor/bin/phpunit -c" },
                ],
                [{ manager: "npm" }],
            )

            assert.match(
                escape?.incompleteReason ?? "",
                /unsafe or escaping path '\.\.\/outside\.php'/,
            )
            assert.deepEqual(escape?.args, [])
            assert.equal(escape?.containedPaths, undefined)
            assert.match(filter?.incompleteReason ?? "", grammar)
            assert.match(joinedSuite?.incompleteReason ?? "", grammar)
            assert.match(joinedConfig?.incompleteReason ?? "", grammar)
            assert.match(separator?.incompleteReason ?? "", grammar)
            assert.match(
                missingSuite?.incompleteReason ?? "",
                /phpunit --testsuite requires a suite name/,
            )
            assert.match(
                missingConfig?.incompleteReason ?? "",
                /phpunit -c\/--configuration requires a configuration file/,
            )
            // Only the exact token routes to phpunit; every other spelling
            // falls through to the catch-all rather than resolving a binary.
            for (const spec of [relative, bareName, phar]) {
                assert.match(
                    spec?.incompleteReason ?? "",
                    /unsupported declared test/,
                )
            }
        })
    })

    it("rejects a phpunit declaration whose binary is not contained", async () => {
        await withTempDir("baro-verify-declared-phpunit-", async (dir) => {
            const [spec] = translateDeclaredTests(
                dir,
                [{ storyId: "S1", command: "vendor/bin/phpunit" }],
                [{ manager: "npm" }],
            )
            assert.match(
                spec?.incompleteReason ?? "",
                /declared phpunit test requires a contained vendor\/bin\/phpunit executable/,
            )
            assert.equal(spec?.tool, "node")
            assert.deepEqual(spec?.args, [])
        })
    })

    it("wraps ddev exec transparently around composer and phpunit", async () => {
        await withTempDir("baro-verify-declared-ddev-", async (dir) => {
            mkdirSync(join(dir, ".ddev"), { recursive: true })
            writeFileSync(join(dir, ".ddev", "config.yaml"), "name: app\n")
            writeFileSync(
                join(dir, "composer.json"),
                JSON.stringify({ scripts: { test: "phpunit", check: "x" } }),
            )
            mkdirSync(join(dir, "vendor", "bin"), { recursive: true })
            writeFileSync(join(dir, "vendor", "bin", "phpunit"), "")
            const [composer, phpunit, labelled] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "ddev exec composer run test" },
                    {
                        storyId: "S1",
                        command: "ddev exec vendor/bin/phpunit --testsuite unit",
                    },
                    { storyId: "S1", command: "ddev exec composer run check" },
                ],
                [{ manager: "npm" }],
            )

            assert.equal(composer?.incompleteReason, undefined)
            assert.equal(composer?.tool, "ddev")
            assert.deepEqual(composer?.args, [
                "exec",
                "composer",
                "run",
                "test",
            ])
            assert.equal(composer?.containedPaths, undefined)
            assert.equal(composer?.cwd, undefined)
            assert.equal(composer?.canonicalDeclaredFocus, undefined)

            // The container receives the declared relative inner token, while
            // containedPaths still carry the host-side values to revalidate.
            assert.equal(phpunit?.incompleteReason, undefined)
            assert.equal(phpunit?.tool, "ddev")
            assert.deepEqual(phpunit?.args, [
                "exec",
                "vendor/bin/phpunit",
                "--testsuite",
                "unit",
            ])
            assert.deepEqual(phpunit?.containedPaths, [
                {
                    path: join(dir, "vendor", "bin", "phpunit"),
                    requireFile: true,
                },
            ])
            assert.equal(
                revalidateContainedPaths(dir, phpunit?.containedPaths ?? []),
                null,
            )

            assert.equal(labelled?.label, "ddev exec composer run check")
        })
    })

    it(
        "leaves no host path in a ddev-wrapped phpunit argv",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-verify-declared-ddev-", async (dir) => {
                mkdirSync(join(dir, ".ddev"), { recursive: true })
                writeFileSync(join(dir, ".ddev", "config.yaml"), "name: app\n")
                mkdirSync(join(dir, "vendor", "bin"), { recursive: true })
                writeFileSync(join(dir, "vendor", "bin", "phpunit"), "")
                writeFileSync(join(dir, "phpunit.xml"), "")
                mkdirSync(join(dir, "tests", "Unit"), { recursive: true })
                const [spec] = translateDeclaredTests(
                    dir,
                    [
                        {
                            storyId: "S1",
                            command:
                                "ddev exec vendor/bin/phpunit -c phpunit.xml tests/Unit",
                        },
                    ],
                    [{ manager: "npm" }],
                )

                // The container has no host filesystem: the wrapped argv must
                // be container-relative end to end, and innerTokens[0] still
                // supplies the declared token rather than the resolved tool.
                assert.equal(spec?.incompleteReason, undefined)
                assert.equal(spec?.tool, "ddev")
                assert.deepEqual(spec?.args, [
                    "exec",
                    "vendor/bin/phpunit",
                    "-c",
                    "phpunit.xml",
                    "tests/Unit",
                ])
                assert.ok(spec?.args.every((value) => !value.includes(dir)))
                assert.equal(
                    revalidateContainedPaths(dir, spec?.containedPaths ?? []),
                    null,
                )
            })
        },
    )

    it("lets ddev exec launder nothing the dispatcher would reject", async () => {
        await withTempDir("baro-verify-declared-ddev-", async (dir) => {
            mkdirSync(join(dir, ".ddev"), { recursive: true })
            writeFileSync(join(dir, ".ddev", "config.yaml"), "name: app\n")
            writeFileSync(
                join(dir, "composer.json"),
                JSON.stringify({ scripts: { custom: "echo" } }),
            )
            mkdirSync(join(dir, "vendor", "bin"), { recursive: true })
            writeFileSync(join(dir, "vendor", "bin", "phpunit"), "")
            const [
                wrappedCustom,
                directCustom,
                wrappedMake,
                directMake,
                wrappedFilter,
                wrappedEscape,
                nested,
            ] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "ddev exec composer run custom" },
                    { storyId: "S1", command: "composer run custom" },
                    { storyId: "S1", command: "ddev exec make test" },
                    { storyId: "S1", command: "make test" },
                    {
                        storyId: "S1",
                        command: "ddev exec vendor/bin/phpunit --filter x",
                    },
                    {
                        storyId: "S1",
                        command: "ddev exec vendor/bin/phpunit ../outside.php",
                    },
                    {
                        storyId: "S1",
                        command: "ddev exec ddev exec composer run custom",
                    },
                ],
                [{ manager: "npm" }],
            )

            assert.ok(wrappedCustom?.incompleteReason)
            assert.equal(
                wrappedCustom?.incompleteReason,
                directCustom?.incompleteReason,
            )
            assert.equal(wrappedCustom?.tool, "node")
            assert.deepEqual(wrappedCustom?.args, [])

            assert.ok(wrappedMake?.incompleteReason)
            assert.equal(
                wrappedMake?.incompleteReason,
                directMake?.incompleteReason,
            )

            assert.match(
                wrappedFilter?.incompleteReason ?? "",
                /phpunit arguments allow only/,
            )
            assert.match(
                wrappedEscape?.incompleteReason ?? "",
                /unsafe or escaping path '\.\.\/outside\.php'/,
            )
            assert.match(
                nested?.incompleteReason ?? "",
                /ddev exec must not wrap another ddev command/,
            )
        })
    })

    it("gates ddev on its subcommand shape and on .ddev/config.yaml", async () => {
        await withTempDir("baro-verify-declared-ddev-", async (dir) => {
            writeFileSync(
                join(dir, "composer.json"),
                JSON.stringify({ scripts: { test: "phpunit" } }),
            )
            const [missingConfig] = translateDeclaredTests(
                dir,
                [{ storyId: "S1", command: "ddev exec composer run test" }],
                [{ manager: "npm" }],
            )
            assert.match(
                missingConfig?.incompleteReason ?? "",
                /declared ddev test requires \.ddev\/config\.yaml in the repository root/,
            )
            assert.deepEqual(missingConfig?.args, [])

            mkdirSync(join(dir, ".ddev"), { recursive: true })
            writeFileSync(join(dir, ".ddev", "config.yaml"), "name: app\n")
            const [ssh, bare, empty, accepted] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "ddev ssh" },
                    { storyId: "S1", command: "ddev" },
                    { storyId: "S1", command: "ddev exec" },
                    { storyId: "S1", command: "ddev exec composer run test" },
                ],
                [{ manager: "npm" }],
            )

            assert.match(
                ssh?.incompleteReason ?? "",
                /ddev tests must use 'ddev exec <command>'/,
            )
            assert.match(
                bare?.incompleteReason ?? "",
                /ddev tests must use 'ddev exec <command>'/,
            )
            assert.match(
                empty?.incompleteReason ?? "",
                /ddev exec requires a command to run/,
            )
            assert.equal(accepted?.incompleteReason, undefined)
        })
    })

    it("keeps npm, cargo, node and git routes bit-identical after the dispatcher split", async () => {
        await withTempDir("baro-verify-declared-regression-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "regression", scripts: { test: "x" } }),
            )
            writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"r\"\n")
            writeFileSync(join(dir, "safe.js"), "")
            const [npm, cargo, node, git] = translateDeclaredTests(
                dir,
                [
                    { storyId: "S1", command: "npm test" },
                    { storyId: "S1", command: "cargo test" },
                    { storyId: "S1", command: "node --test safe.js" },
                    { storyId: "S1", command: "git diff --check" },
                ],
                [{ manager: "npm" }],
            )

            for (const spec of [npm, cargo, node, git]) {
                assert.equal(spec?.incompleteReason, undefined)
            }
            // No install/fetch subcommand: execution reuses the already
            // installed root dependencies and cargo artefacts.
            assert.deepEqual(
                { label: npm?.label, tool: npm?.tool, args: npm?.args },
                { label: "npm run test", tool: "npm", args: ["run", "test"] },
            )
            assert.deepEqual(
                { label: cargo?.label, tool: cargo?.tool, args: cargo?.args },
                { label: "cargo test", tool: "cargo", args: ["test"] },
            )
            assert.deepEqual(
                { label: node?.label, tool: node?.tool, args: node?.args },
                {
                    label: "node --test safe.js",
                    tool: "node",
                    args: ["--test", "safe.js"],
                },
            )
            assert.deepEqual(
                { label: git?.label, tool: git?.tool, args: git?.args },
                {
                    label: "git diff --check",
                    tool: "git",
                    args: ["diff", "--no-ext-diff", "--no-textconv", "--check"],
                },
            )
        })
    })

    it("names the php-ecosystem routes in the catch-all message", async () => {
        await withTempDir("baro-verify-declared-catch-all-", async (dir) => {
            const [spec] = translateDeclaredTests(
                dir,
                [{ storyId: "S1", command: "make test" }],
                [{ manager: "npm" }],
            )
            assert.equal(
                spec?.incompleteReason,
                "unsupported declared test; allowed tools are npm/pnpm/yarn, exact npx rstest run paths, cargo, node, git diff --check, composer, vendor/bin/phpunit, and ddev exec",
            )
        })
    })

})

describe("greenfield bare node declarations", () => {
    it("allows bare `node <file>` only without package.json", async () => {
        const { translateDeclaredTests } = await import(
            "../../src/verification/declared-verification.js"
        )
        const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
        const { tmpdir } = await import("node:os")
        const { join } = await import("node:path")
        const requirement = {
            storyId: "S1",
            command: "node test.js",
        }
        const bare = mkdtempSync(join(tmpdir(), "baro-df-bare-"))
        try {
            writeFileSync(join(bare, "test.js"), "process.exit(0)")
            const [spec] = translateDeclaredTests(bare, [requirement], ["npm"])
            assert.equal(spec?.tool, "node")
            assert.deepEqual(spec?.args, ["test.js"])
        } finally {
            rmSync(bare, { recursive: true, force: true })
        }
        const withManifest = mkdtempSync(join(tmpdir(), "baro-df-manifest-"))
        try {
            writeFileSync(join(withManifest, "package.json"), "{}")
            const [spec] = translateDeclaredTests(
                withManifest,
                [requirement],
                ["npm"],
            )
            assert.match(spec?.incompleteReason ?? "", /without package\.json/)
        } finally {
            rmSync(withManifest, { recursive: true, force: true })
        }
        const traversal = mkdtempSync(join(tmpdir(), "baro-df-escape-"))
        try {
            const [spec] = translateDeclaredTests(
                traversal,
                [{ storyId: "S1", command: "node ../evil.js" }],
                ["npm"],
            )
            assert.ok(spec?.incompleteReason)
        } finally {
            rmSync(traversal, { recursive: true, force: true })
        }
    })
})
