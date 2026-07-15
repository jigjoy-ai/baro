import assert from "node:assert/strict"
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"

import type { Tool } from "@mozaik-ai/core"

import {
    createReadOnlyRepositoryScoutTools,
    invokeRepositoryResearchTool,
} from "../../src/session/repository-research-tools.js"

describe("repository research tool cancellation", () => {
    it("aborts each built-in during traversal and performs no late work", async () => {
        await withLargeRepository(async (root) => {
            const tools = new Map(
                createReadOnlyRepositoryScoutTools(root)
                    .map((tool) => [tool.name, tool]),
            )
            const cases: ReadonlyArray<readonly [
                name: "read_file" | "grep" | "glob",
                args: Record<string, string>,
            ]> = [
                ["read_file", { path: "large.md" }],
                ["grep", {
                    pattern: "text-that-is-not-present",
                    path: "",
                    file_pattern: "*.ts",
                }],
                ["glob", { pattern: "**/*.never" }],
            ]

            for (const [name, args] of cases) {
                const tool = tools.get(name)
                assert.ok(tool, `missing ${name} tool`)
                const controller = new AbortController()
                let cooperativeYields = 0
                const pending = invokeRepositoryResearchTool(tool, args, {
                    signal: controller.signal,
                    onCooperativeYield() {
                        cooperativeYields += 1
                        if (cooperativeYields === 2) controller.abort()
                    },
                })

                await assert.rejects(pending, (error: unknown) => {
                    assert.ok(error instanceof Error)
                    assert.equal(error.name, "AbortError")
                    return true
                })
                assert.equal(
                    cooperativeYields,
                    2,
                    `${name} should stop well before its configured traversal limit`,
                )
                const yieldsAtSettlement = cooperativeYields
                await delay(25)
                assert.equal(
                    cooperativeYields,
                    yieldsAtSettlement,
                    `${name} continued after its invocation rejected`,
                )
            }
        })
    })

    it("enforces caller deadlines before invoking a built-in", async () => {
        await withLargeRepository(async (root) => {
            const tool = createReadOnlyRepositoryScoutTools(root)
                .find((candidate) => candidate.name === "glob")
            assert.ok(tool)
            await assert.rejects(
                invokeRepositoryResearchTool(tool, { pattern: "**/*.ts" }, {
                    signal: new AbortController().signal,
                    deadlineMs: Date.now() - 1,
                }),
                (error: unknown) => {
                    assert.ok(error instanceof Error)
                    assert.equal(error.name, "TimeoutError")
                    return true
                },
            )
        })
    })

    it("keeps injected generic Mozaik tools compatible", async () => {
        let invocations = 0
        const tool: Tool = {
            type: "function",
            name: "injected_tool",
            description: "Provider-free generic test tool",
            strict: true,
            parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
            },
            async invoke() {
                invocations += 1
                return "generic result"
            },
        }

        assert.equal(
            await invokeRepositoryResearchTool(tool, {}, {
                signal: new AbortController().signal,
            }),
            "generic result",
        )
        assert.equal(invocations, 1)
    })

    it("rejects direct reads and searches through ignored work directories", async () => {
        await withRepository(async (root) => {
            mkdirSync(join(root, "dist"))
            mkdirSync(join(root, "node_modules", "dependency"), { recursive: true })
            mkdirSync(join(root, "src"))
            writeFileSync(join(root, "dist", "hidden.ts"), "ignored-needle\n")
            writeFileSync(
                join(root, "node_modules", "dependency", "hidden.ts"),
                "ignored-needle\n",
            )
            writeFileSync(join(root, "src", "target.rs"), "visible-needle\n")
            const tools = new Map(
                createReadOnlyRepositoryScoutTools(root)
                    .map((tool) => [tool.name, tool]),
            )
            const signal = new AbortController().signal

            assert.match(String(await invokeRepositoryResearchTool(
                tools.get("read_file")!,
                { path: "dist/hidden.ts" },
                { signal },
            )), /^Error:/u)
            assert.match(String(await invokeRepositoryResearchTool(
                tools.get("read_file")!,
                { path: "node_modules/dependency/hidden.ts" },
                { signal },
            )), /^Error:/u)
            assert.match(String(await invokeRepositoryResearchTool(
                tools.get("grep")!,
                { pattern: "ignored-needle", path: "dist", file_pattern: "*.ts" },
                { signal },
            )), /^Error:/u)
            assert.equal(String(await invokeRepositoryResearchTool(
                tools.get("read_file")!,
                { path: "src/target.rs" },
                { signal },
            )), "visible-needle\n")
            assert.equal(String(await invokeRepositoryResearchTool(
                tools.get("grep")!,
                { pattern: "ignored-needle", path: "", file_pattern: "*.ts" },
                { signal },
            )), "No matches found.")
        })
    })

    it("bounds one directory collection and emits search/glob limit markers", async () => {
        await withRepository(async (root) => {
            for (let index = 0; index < 8; index += 1) {
                writeFileSync(
                    join(root, `entry-${index}.ts`),
                    `export const bounded${index} = "directory-needle"\n`,
                )
            }
            const tools = new Map(
                createReadOnlyRepositoryScoutTools(root)
                    .map((tool) => [tool.name, tool]),
            )
            const signal = new AbortController().signal
            const glob = String(await invokeRepositoryResearchTool(
                tools.get("glob")!,
                { pattern: "*.ts" },
                { signal, maxDirectoryEntries: 4 },
            ))
            const search = String(await invokeRepositoryResearchTool(
                tools.get("grep")!,
                {
                    pattern: "directory-needle",
                    path: "",
                    file_pattern: "*.ts",
                },
                { signal, maxDirectoryEntries: 4 },
            ))

            assert.match(glob, /glob limit reached/u)
            assert.equal(
                glob.split("\n").filter((line) => line.endsWith(".ts")).length,
                4,
            )
            assert.match(search, /search limit reached/u)
            assert.equal(
                search.split("\n").filter((line) => /\.ts:[1-9][0-9]*:/u.test(line)).length,
                4,
            )
        })
    })

    it("batches glob DP checkpoints while retaining mid-match cancellation", async () => {
        await withRepository(async (root) => {
            const stem = "a".repeat(180)
            const path = `${stem}.ts`
            writeFileSync(join(root, path), "export const matched = true\n")
            const glob = createReadOnlyRepositoryScoutTools(root)
                .find((tool) => tool.name === "glob")
            assert.ok(glob)
            const pattern = `${"?".repeat(stem.length)}.ts`

            let completedYields = 0
            const result = String(await invokeRepositoryResearchTool(
                glob,
                { pattern },
                {
                    signal: new AbortController().signal,
                    onCooperativeYield: () => { completedYields += 1 },
                },
            ))
            assert.equal(result, path)
            assert.ok(completedYields >= 4, "long DP match should remain cooperative")
            assert.ok(
                completedYields < 32,
                `glob DP yielded ${completedYields} times instead of batching work`,
            )

            const controller = new AbortController()
            let cancelledYields = 0
            await assert.rejects(
                invokeRepositoryResearchTool(glob, { pattern }, {
                    signal: controller.signal,
                    onCooperativeYield() {
                        cancelledYields += 1
                        controller.abort()
                    },
                }),
                (error: unknown) => {
                    assert.ok(error instanceof Error)
                    assert.equal(error.name, "AbortError")
                    return true
                },
            )
            assert.equal(cancelledYields, 1)
        })
    })
})

async function withRepository(
    run: (root: string) => Promise<void>,
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "baro-research-tool-fixture-"))
    try {
        await run(root)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

async function withLargeRepository(
    run: (root: string) => Promise<void>,
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "baro-research-tools-"))
    try {
        writeFileSync(join(root, "large.md"), Buffer.alloc(400 * 1024, 97))
        const source = join(root, "src")
        mkdirSync(source)
        for (let index = 0; index < 512; index += 1) {
            writeFileSync(
                join(source, `file-${String(index).padStart(4, "0")}.ts`),
                `export const value${index} = ${index}\n`,
            )
        }
        await run(root)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}
