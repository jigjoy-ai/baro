import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
    __resetOpenCodeMajorCache,
    openCodeMajor,
    openCodeRunArgs,
} from "../../../src/harness/opencode/cli-version.js"
import { withTempDir } from "../../execution/helpers.js"

function fakeOpenCode(dir: string, version: string): string {
    const bin = join(dir, "opencode")
    writeFileSync(bin, `#!/bin/sh\necho "${version}"\n`)
    chmodSync(bin, 0o755)
    return bin
}

describe("opencode flags by major version", { skip: process.platform === "win32" }, () => {
    let pinned: string | undefined
    beforeEach(() => {
        pinned = process.env.BARO_OPENCODE_MAJOR
        delete process.env.BARO_OPENCODE_MAJOR
        __resetOpenCodeMajorCache()
    })
    afterEach(() => {
        if (pinned === undefined) delete process.env.BARO_OPENCODE_MAJOR
        else process.env.BARO_OPENCODE_MAJOR = pinned
    })

    it("reads the major version from --version", async () => {
        await withTempDir("baro-oc-", async (dir) => {
            assert.equal(openCodeMajor(fakeOpenCode(dir, "opencode v2.0.27")), 2)
        })
        await withTempDir("baro-oc-", async (dir) => {
            assert.equal(openCodeMajor(fakeOpenCode(dir, "1.14.3")), 1)
        })
    })

    it("sends 2.0 a private server, --auto and the process cwd instead of --dir", async () => {
        await withTempDir("baro-oc-", async (dir) => {
            const bin = fakeOpenCode(dir, "opencode v2.0.27")
            assert.deepEqual(
                openCodeRunArgs(bin, { cwd: "/repo", model: "opencode/big-pickle", autoApprove: true }),
                ["run", "--format", "json", "--standalone", "--auto", "-m", "opencode/big-pickle"],
            )
            assert.deepEqual(
                openCodeRunArgs(bin, { cwd: "/repo", evaluatorAgent: "baro-critic" }),
                ["run", "--format", "json", "--standalone", "--agent", "baro-critic"],
            )
        })
    })

    it("keeps the 1.x flags", async () => {
        await withTempDir("baro-oc-", async (dir) => {
            const bin = fakeOpenCode(dir, "1.14.3")
            assert.deepEqual(
                openCodeRunArgs(bin, { cwd: "/repo", model: "m", autoApprove: true }),
                ["run", "--format", "json", "--dangerously-skip-permissions", "-m", "m", "--dir", "/repo"],
            )
            assert.deepEqual(
                openCodeRunArgs(bin, { cwd: "/repo", evaluatorAgent: "baro-critic" }),
                ["run", "--format", "json", "--pure", "--agent", "baro-critic", "--dir", "/repo"],
            )
        })
    })
})
