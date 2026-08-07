import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { createStoryTools } from "../../src/planning/adapters/story-tools.js"
import { withTempDir } from "../execution/helpers.js"
import type { Tool } from "../../src/runtime/mozaik.js"

const SURFACE = {
    writes: ["src/audit/audit.service.ts", "src/app.module.ts"],
    ownedElsewhere: {
        "src/menus/menu/menu.service.ts": "S6",
        "src/shops/shops.service.ts": "S4",
    },
}

function tools(cwd: string, surface = SURFACE): Map<string, Tool> {
    const list = createStoryTools(cwd, { surface })
    return new Map(list.map((tool) => [tool.name, tool]))
}

async function call(tool: Tool | undefined, args: unknown): Promise<string> {
    assert.ok(tool, "expected the tool to exist")
    const result = await tool!.invoke(args as never)
    return typeof result === "string" ? result : JSON.stringify(result)
}

function repo(dir: string): string {
    mkdirSync(join(dir, "src", "audit"), { recursive: true })
    mkdirSync(join(dir, "src", "menus", "menu"), { recursive: true })
    writeFileSync(join(dir, "src", "menus", "menu", "menu.service.ts"), "export class MenuService {}\n")
    writeFileSync(join(dir, "src", "audit", "audit.service.ts"), "export class AuditService {}\n")
    return dir
}

// The prompt already names every file this story may write, every file another
// story owns, and what to do instead of reaching into one. A live foundation
// story read all of it and instrumented four other stories' services anyway,
// to prove its own service worked end to end. Its evidence then described a
// tree it had changed underneath itself, the Critic could only answer
// "unverifiable", and the nine stories waiting on it were skipped.
describe("the write surface is enforced where the model acts", () => {
    it("refuses a file another story owns, and names the owner", async () => {
        await withTempDir("baro-surface-refuse-", async (dir) => {
            repo(dir)
            const out = await call(tools(dir).get("edit_file"), {
                path: "src/menus/menu/menu.service.ts",
                old: "export class MenuService {}",
                new: "export class MenuService { audit() {} }",
            })
            assert.match(out, /belongs to story S6/u)
            assert.match(out, /loses this whole story/u)
            assert.match(out, /Ask S6|block on S6|dispute/u)
            // And the file is untouched — a refusal that still writes is theatre.
            assert.equal(
                readFileSync(join(dir, "src", "menus", "menu", "menu.service.ts"), "utf8"),
                "export class MenuService {}\n",
            )
        })
    })

    it("refuses to create a file inside another story's surface", async () => {
        await withTempDir("baro-surface-create-", async (dir) => {
            repo(dir)
            const out = await call(tools(dir).get("write_file"), {
                path: "src/shops/shops.service.ts",
                content: "export class ShopsService {}\n",
            })
            assert.match(out, /belongs to story S4/u)
        })
    })

    it("writes what the story declared, without ceremony", async () => {
        await withTempDir("baro-surface-allow-", async (dir) => {
            repo(dir)
            const out = await call(tools(dir).get("write_file"), {
                path: "src/audit/audit.service.ts",
                content: "export class AuditService { record() {} }\n",
            })
            assert.match(out, /^Wrote src\/audit\/audit\.service\.ts/u)
            assert.ok(!/Note:/u.test(out), "a declared write needs no warning")
        })
    })

    // Undeclared and unowned is not the measured harm, and the gate remains the
    // authority — so it is allowed, and said out loud rather than swallowed.
    it("allows an unowned path it never declared, and says so", async () => {
        await withTempDir("baro-surface-note-", async (dir) => {
            repo(dir)
            const out = await call(tools(dir).get("write_file"), {
                path: "src/audit/audit.helper.ts",
                content: "export const helper = 1\n",
            })
            assert.match(out, /^Wrote src\/audit\/audit\.helper\.ts/u)
            assert.match(out, /not in this story's declared write surface/u)
            assert.match(out, /merge gate is the authority/u)
        })
    })

    it("leaves a story with no declared surface alone", async () => {
        await withTempDir("baro-surface-none-", async (dir) => {
            repo(dir)
            const list = createStoryTools(dir)
            const write = new Map(list.map((tool) => [tool.name, tool])).get("write_file")
            const out = await call(write, {
                path: "src/menus/menu/menu.service.ts",
                content: "export class MenuService { audited = true }\n",
            })
            assert.match(out, /^Wrote/u, "no boundary known means no boundary claimed")
        })
    })
})
