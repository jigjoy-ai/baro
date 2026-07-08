import { writeFileSync } from "node:fs"
import { join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { verifyBuild } from "../src/verify.js"
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
        })
    })

    it("returns {ran:false} when there is no build/test script to run", async () => {
        await withTempDir("baro-verify-", async (dir) => {
            writeFileSync(
                join(dir, "package.json"),
                JSON.stringify({ name: "v", scripts: { lint: "true" } }),
            )
            const r = await verifyBuild(dir)
            assert.equal(r.ran, false)
            assert.equal(r.ok, true)
            assert.equal(r.failures.length, 0)
        })
    })

    it("returns {ran:false} when there is no manifest at all", async () => {
        await withTempDir("baro-verify-", async (dir) => {
            const r = await verifyBuild(dir)
            assert.equal(r.ran, false)
            assert.equal(r.ok, true)
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
        })
    })
})
