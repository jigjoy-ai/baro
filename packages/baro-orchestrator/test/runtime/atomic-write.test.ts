import assert from "node:assert/strict"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { writeFileAtomic } from "../../src/runtime/atomic-write.js"
import { withTempDir } from "../execution/helpers.js"

describe("writeFileAtomic", () => {
    it("replaces the destination and leaves no temporary behind", async () => {
        await withTempDir("baro-atomic-", async (dir) => {
            const path = join(dir, "result.json")
            writeFileSync(path, "old")
            writeFileAtomic(path, "new")
            assert.equal(readFileSync(path, "utf8"), "new")
            assert.deepEqual(readdirSync(dir), ["result.json"])
        })
    })

    it("writes in place when the open destination cannot be replaced (#192)", async () => {
        await withTempDir("baro-atomic-", async (dir) => {
            const path = join(dir, "result.json")
            writeFileSync(path, "")
            writeFileAtomic(path, "architect result", () => {
                throw Object.assign(new Error("operation not permitted, rename"), { code: "EPERM" })
            })
            assert.equal(readFileSync(path, "utf8"), "architect result")
            assert.deepEqual(readdirSync(dir), ["result.json"])
        })
    })

    it("still fails on any other rename error", async () => {
        await withTempDir("baro-atomic-", async (dir) => {
            assert.throws(
                () => writeFileAtomic(join(dir, "result.json"), "x", () => {
                    throw Object.assign(new Error("no space"), { code: "ENOSPC" })
                }),
                /no space/,
            )
        })
    })
})
