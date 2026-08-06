import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { createCodebaseTools } from "../../src/planning/adapters/codebase-tools.js"
import { withTempDir } from "../execution/helpers.js"
import type { Tool } from "../../src/runtime/mozaik.js"

function toolNamed(tools: Tool[], name: string): Tool {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.ok(tool, `expected a ${name} tool`)
    return tool!
}

async function call(tool: Tool, args: unknown): Promise<string> {
    const result = await tool.invoke(args as never)
    return typeof result === "string" ? result : JSON.stringify(result)
}

function fixture(dir: string): void {
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(
        join(dir, "src", "menu.service.ts"),
        "import { DataSource } from 'typeorm'\nexport class MenuService {\n  save() { return this.dataSource.transaction(cb) }\n}\n",
    )
    writeFileSync(
        join(dir, "src", "table.service.ts"),
        "export class TableService {\n  save() { return this.repo.save(x) }\n}\n",
    )
    writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n')
}

// One round-trip per file is the whole cost of exploration on a lane where the
// model issues a single call at a time: a live Architect spent sixty rounds and
// a 141k context reading one service. Whether a model batches is a property of
// the model; a tool that takes a list is not.
describe("reading many files is one call, not many rounds", () => {
    it("returns every file under its own header", async () => {
        await withTempDir("baro-read-files-", async (dir) => {
            fixture(dir)
            const tools = createCodebaseTools(dir, { includeBash: false })
            const out = await call(toolNamed(tools, "read_files"), {
                paths: ["src/menu.service.ts", "src/table.service.ts", "package.json"],
            })
            assert.match(out, /=== src\/menu\.service\.ts ===/u)
            assert.match(out, /=== src\/table\.service\.ts ===/u)
            assert.match(out, /"name":"fixture"/u)
        })
    })

    it("reports a missing or escaping path in place instead of failing", async () => {
        await withTempDir("baro-read-files-missing-", async (dir) => {
            fixture(dir)
            const tools = createCodebaseTools(dir, { includeBash: false })
            const out = await call(toolNamed(tools, "read_files"), {
                paths: ["src/menu.service.ts", "src/nope.ts", "../../etc/passwd"],
            })
            assert.match(out, /MenuService/u, "the readable file still came back")
            assert.match(out, /File not found: src\/nope\.ts/u)
            assert.match(out, /escapes the project root/u)
        })
    })
})

describe("a batch is several calls and one result", () => {
    it("runs each call and labels its output", async () => {
        await withTempDir("baro-batch-", async (dir) => {
            fixture(dir)
            const tools = createCodebaseTools(dir, { includeBash: false })
            const out = await call(toolNamed(tools, "batch"), {
                calls: [
                    { tool: "read_file", args: { path: "package.json" } },
                    { tool: "list_files", args: { path: "src" } },
                ],
            })
            assert.match(out, /=== read_file /u)
            assert.match(out, /=== list_files /u)
            assert.match(out, /"name":"fixture"/u)
            assert.match(out, /menu\.service\.ts/u)
        })
    })

    it("keeps only the lines that match, so the finding travels and the file does not", async () => {
        await withTempDir("baro-batch-match-", async (dir) => {
            fixture(dir)
            const tools = createCodebaseTools(dir, { includeBash: false })
            const out = await call(toolNamed(tools, "batch"), {
                calls: [
                    {
                        tool: "read_files",
                        args: {
                            paths: ["src/menu.service.ts", "src/table.service.ts"],
                        },
                        match: "dataSource\\.transaction",
                    },
                ],
            })
            assert.match(out, /dataSource\.transaction/u)
            assert.ok(
                !/class TableService/u.test(out),
                "an unmatched line must not reach the context",
            )
        })
    })

    it("names a bad tool and a bad pattern rather than throwing", async () => {
        await withTempDir("baro-batch-errors-", async (dir) => {
            fixture(dir)
            const tools = createCodebaseTools(dir, { includeBash: false })
            const out = await call(toolNamed(tools, "batch"), {
                calls: [
                    { tool: "no_such_tool", args: {} },
                    {
                        tool: "read_file",
                        args: { path: "package.json" },
                        match: "([",
                    },
                ],
            })
            assert.match(out, /tool 'no_such_tool' is not available here/u)
            assert.match(out, /is not a valid regular expression/u)
            assert.match(out, /"name":"fixture"/u, "the full output still came back")
        })
    })

    it("cannot batch a batch", async () => {
        await withTempDir("baro-batch-nesting-", async (dir) => {
            fixture(dir)
            const tools = createCodebaseTools(dir, { includeBash: false })
            const out = await call(toolNamed(tools, "batch"), {
                calls: [{ tool: "batch", args: { calls: [] } }],
            })
            assert.match(out, /tool 'batch' is not available here/u)
        })
    })

    it("stays out of a role that must never receive a shell", async () => {
        await withTempDir("baro-batch-readonly-", async (dir) => {
            fixture(dir)
            const tools = createCodebaseTools(dir, { includeBash: false })
            const out = await call(toolNamed(tools, "batch"), {
                calls: [{ tool: "bash", args: { command: "echo hi" } }],
            })
            assert.match(out, /tool 'bash' is not available here/u)
        })
    })
})
