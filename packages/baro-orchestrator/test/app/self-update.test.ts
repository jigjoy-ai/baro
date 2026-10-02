import assert from "node:assert/strict"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { withTempDir } from "../execution/helpers.js"

// The launcher ships as plain .mjs in the baro-ai package.
const { selfUpdate, semverLt, skipReason } = (await import(
    "../../../baro-app/bin/self-update.mjs" as string
)) as {
    selfUpdate(options: {
        packageVersion: string
        argv: string[]
        env?: NodeJS.ProcessEnv
        isTTY?: boolean
    }): Promise<{ updated: boolean; reason: string | null }>
    semverLt(a: string, b: string): boolean
    skipReason(options: {
        argv: string[]
        env: NodeJS.ProcessEnv
        isTTY: boolean
        liveRuns: number
    }): string | null
}

describe("baro launcher self-update", () => {
    it("compares versions numerically", () => {
        assert.equal(semverLt("0.118.6", "0.118.10"), true)
        assert.equal(semverLt("0.118.6", "0.118.6"), false)
        assert.equal(semverLt("1.0.0", "0.999.0"), false)
    })

    it("only a hand-started interactive run may update", () => {
        const base = { argv: ["Add a feature"], env: {}, isTTY: true, liveRuns: 0 }
        assert.equal(skipReason(base), null)
        assert.equal(skipReason({ ...base, isTTY: false }), "not a terminal")
        assert.equal(skipReason({ ...base, argv: ["--headless", "x"] }), "headless")
        assert.equal(skipReason({ ...base, argv: ["connect"] }), "quick command")
        assert.equal(skipReason({ ...base, argv: ["--version"] }), "quick command")
        assert.equal(skipReason({ ...base, env: { CI: "true" } }), "CI")
        assert.equal(skipReason({ ...base, env: { BARO_NO_SELF_UPDATE: "1" } }), "BARO_NO_SELF_UPDATE=1")
        assert.equal(skipReason({ ...base, liveRuns: 1 }), "another baro run is active")
    })

    async function withStagedHome<T>(
        run: (home: string) => Promise<T>,
    ): Promise<T> {
        return withTempDir("baro-self-update-", async (root) => {
            const home = join(root, "home")
            const bin = join(root, "bin")
            mkdirSync(join(home, ".baro", "bin"), { recursive: true })
            mkdirSync(bin)
            writeFileSync(
                join(home, ".baro", "bin", "bundle-version.json"),
                JSON.stringify({ version: "1.0.0" }),
            )
            // A fresh cache answers the version question without the network.
            writeFileSync(
                join(home, ".baro", "update-check.json"),
                JSON.stringify({ latest: "9.9.9", checkedAt: Date.now() }),
            )
            // Stands in for `npm install -g baro-ai@<v>`: records the call and
            // stages the version the way postinstall would.
            const npm = join(bin, "npm")
            writeFileSync(
                npm,
                `#!/bin/sh\necho "$@" > "${join(root, "npm-args")}"\n` +
                    `printf '{"version":"9.9.9"}' > "${join(home, ".baro", "bin", "bundle-version.json")}"\n`,
            )
            chmodSync(npm, 0o755)
            const saved = { HOME: process.env.HOME, PATH: process.env.PATH }
            process.env.HOME = home
            process.env.PATH = `${bin}:${saved.PATH ?? ""}`
            try {
                return await run(root)
            } finally {
                process.env.HOME = saved.HOME
                process.env.PATH = saved.PATH
            }
        })
    }

    it("installs the newer version before the run starts", { skip: process.platform === "win32" }, async () => {
        await withStagedHome(async (root) => {
            const result = await selfUpdate({ packageVersion: "1.0.0", argv: ["goal"], env: {}, isTTY: true })
            assert.deepEqual(result, { updated: true, reason: null })
            assert.equal(
                readFileSync(join(root, "npm-args"), "utf8").trim(),
                "install -g baro-ai@9.9.9",
            )
        })
    })

    it("leaves the install alone while another baro run is active", { skip: process.platform === "win32" }, async () => {
        await withStagedHome(async (root) => {
            const live = join(root, "home", ".baro", "live")
            mkdirSync(live)
            writeFileSync(join(live, "run-1.json"), JSON.stringify({ id: "run-1", pid: process.pid }))
            const result = await selfUpdate({ packageVersion: "1.0.0", argv: ["goal"], env: {}, isTTY: true })
            assert.equal(result.updated, false)
            assert.equal(result.reason, "another baro run is active")
        })
    })

    it("does nothing for automation", { skip: process.platform === "win32" }, async () => {
        await withStagedHome(async () => {
            const result = await selfUpdate({ packageVersion: "1.0.0", argv: ["--headless", "goal"], env: {}, isTTY: true })
            assert.deepEqual(result, { updated: false, reason: "headless" })
        })
    })
})
