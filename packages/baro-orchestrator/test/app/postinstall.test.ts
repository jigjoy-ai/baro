import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { describe, it } from "@rstest/core"
import { fileURLToPath, pathToFileURL } from "node:url"

import { withTempDir } from "../execution/helpers.js"

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../../../baro-app")

// Preloaded into the script: every download is served the fake binary in
// FAKE_BARO_BINARY and logged, so no test ever reaches the network.
const FAKE_HTTPS = `
import https from "node:https"
import { EventEmitter } from "node:events"
import { appendFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { Readable } from "node:stream"
https.get = (url, _options, onResponse) => {
    appendFileSync(process.env.FAKE_DOWNLOAD_LOG, url + "\\n")
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.destroy = (err) => req.emit("error", err)
    process.nextTick(() => {
        const res = Readable.from([process.env.FAKE_BARO_BINARY ?? ""])
        res.statusCode = 200
        res.headers = {}
        onResponse(res)
    })
    return req
}
syncBuiltinESMExports()
`

type Layout = "checkout" | "installed"

interface Fixture {
    root: string
    home: string
    baroBin: string
    script: string
    downloads: () => string[]
}

function fakeBinary(version: string): string {
    return `#!/bin/sh\necho "baro ${version}"\n`
}

function stage(tempDir: string, layout: Layout, version: string, installed?: string): Fixture {
    // The script's run-as-main check compares real paths (macOS: /var -> /private/var).
    const root = realpathSync(tempDir)
    const pkg = layout === "checkout"
        ? join(root, "checkout", "packages", "baro-app")
        : join(root, "global", "lib", "node_modules", "baro-ai")
    mkdirSync(join(pkg, "scripts"), { recursive: true })
    mkdirSync(join(pkg, "bin"), { recursive: true })
    mkdirSync(join(pkg, "dist"), { recursive: true })
    copyFileSync(join(APP, "scripts", "postinstall.js"), join(pkg, "scripts", "postinstall.js"))
    copyFileSync(join(APP, "bin", "self-update.mjs"), join(pkg, "bin", "self-update.mjs"))
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "baro-ai", version, type: "module" }))
    writeFileSync(join(pkg, "dist", "cli.mjs"), `// bundle ${version}\n`)
    writeFileSync(join(root, "fake-https.mjs"), FAKE_HTTPS)

    const home = join(root, "home")
    const baroBin = join(home, ".baro", "bin")
    mkdirSync(home, { recursive: true })
    if (installed) {
        mkdirSync(baroBin, { recursive: true })
        writeFileSync(join(baroBin, "baro"), fakeBinary(installed))
        chmodSync(join(baroBin, "baro"), 0o755)
        writeFileSync(join(baroBin, "cli.mjs"), `// bundle ${installed}\n`)
        writeFileSync(join(baroBin, "bundle-version.json"), JSON.stringify({ version: installed }))
    }
    const log = join(root, "downloads.log")
    return {
        root,
        home,
        baroBin,
        script: join(pkg, "scripts", "postinstall.js"),
        downloads: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    }
}

function runPostinstall(
    fixture: Fixture,
    serve: string,
    extraEnv: Record<string, string> = {},
): { stdout: string; status: number | null } {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of ["SUDO_USER", "SUDO_UID", "SUDO_GID", "BARO_SKIP_POSTINSTALL", "BARO_ALLOW_DOWNGRADE"]) {
        delete env[key]
    }
    const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(join(fixture.root, "fake-https.mjs")).href, fixture.script],
        {
            encoding: "utf8",
            timeout: 60_000,
            env: {
                ...env,
                HOME: fixture.home,
                USERPROFILE: fixture.home,
                FAKE_BARO_BINARY: serve,
                FAKE_DOWNLOAD_LOG: join(fixture.root, "downloads.log"),
                ...extraEnv,
            },
        },
    )
    return { stdout: result.stdout, status: result.status }
}

function snapshot(dir: string): Record<string, string> | null {
    if (!existsSync(dir)) return null
    return Object.fromEntries(
        readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf8")]),
    )
}

function installedVersion(fixture: Fixture): string {
    const out = spawnSync(join(fixture.baroBin, "baro"), ["--version"], { encoding: "utf8" }).stdout
    return out.trim()
}

const unixIt = it.skipIf(process.platform === "win32")

describe("baro-ai postinstall and the installed baro", () => {
    unixIt("leaves ~/.baro/bin alone when it runs from a source checkout", async () => {
        await withTempDir("baro-postinstall-", (root) => {
            const fixture = stage(root, "checkout", "0.130.0", "0.132.0")
            const before = snapshot(fixture.baroBin)

            const { stdout, status } = runPostinstall(fixture, fakeBinary("0.130.0"))

            assert.equal(status, 0)
            const lines = stdout.trim().split("\n")
            assert.equal(lines.length, 1, stdout)
            assert.match(lines[0], /source checkout.*cargo build --release -p baro-tui/)
            assert.deepEqual(fixture.downloads(), [])
            assert.deepEqual(snapshot(fixture.baroBin), before)
        })
    })

    unixIt("creates nothing under ~/.baro from a checkout on a machine without baro", async () => {
        await withTempDir("baro-postinstall-", (root) => {
            const fixture = stage(root, "checkout", "0.130.0")

            runPostinstall(fixture, fakeBinary("0.130.0"))

            assert.equal(existsSync(join(fixture.home, ".baro")), false)
        })
    })

    unixIt("installs the binary and bundles from node_modules when none is installed", async () => {
        await withTempDir("baro-postinstall-", (root) => {
            const fixture = stage(root, "installed", "0.132.0")

            const { status } = runPostinstall(fixture, fakeBinary("0.132.0"))

            assert.equal(status, 0)
            assert.equal(fixture.downloads().length, 1)
            assert.match(fixture.downloads()[0], /\/download\/v0\.132\.0\//)
            assert.equal(installedVersion(fixture), "baro 0.132.0")
            assert.equal(readFileSync(join(fixture.baroBin, "cli.mjs"), "utf8"), "// bundle 0.132.0\n")
            assert.equal(
                JSON.parse(readFileSync(join(fixture.baroBin, "bundle-version.json"), "utf8")).version,
                "0.132.0",
            )
        })
    })

    unixIt("replaces an installed binary of the same or an older version", async () => {
        for (const installed of ["0.131.9", "0.132.0"]) {
            await withTempDir("baro-postinstall-", (root) => {
                const fixture = stage(root, "installed", "0.132.0", installed)

                runPostinstall(fixture, fakeBinary("0.132.0"))

                assert.equal(installedVersion(fixture), "baro 0.132.0", `over ${installed}`)
                assert.equal(readFileSync(join(fixture.baroBin, "cli.mjs"), "utf8"), "// bundle 0.132.0\n")
            })
        }
    })

    unixIt("refuses to downgrade the installed baro unless BARO_ALLOW_DOWNGRADE=1", async () => {
        await withTempDir("baro-postinstall-", (root) => {
            const fixture = stage(root, "installed", "0.130.0", "0.132.0")
            const before = snapshot(fixture.baroBin)

            const { stdout, status } = runPostinstall(fixture, fakeBinary("0.130.0"))

            assert.equal(status, 0)
            assert.match(stdout, /kept the installed baro 0\.132\.0.*BARO_ALLOW_DOWNGRADE=1/)
            assert.deepEqual(fixture.downloads(), [])
            assert.deepEqual(snapshot(fixture.baroBin), before)

            runPostinstall(fixture, fakeBinary("0.130.0"), { BARO_ALLOW_DOWNGRADE: "1" })

            assert.equal(installedVersion(fixture), "baro 0.130.0")
            assert.equal(readFileSync(join(fixture.baroBin, "cli.mjs"), "utf8"), "// bundle 0.130.0\n")
        })
    })

    unixIt("leaves ~/.baro/bin alone under BARO_SKIP_POSTINSTALL=1", async () => {
        await withTempDir("baro-postinstall-", (root) => {
            const fixture = stage(root, "installed", "0.133.0", "0.132.0")
            const before = snapshot(fixture.baroBin)

            const { stdout } = runPostinstall(fixture, fakeBinary("0.133.0"), { BARO_SKIP_POSTINSTALL: "1" })

            assert.match(stdout, /BARO_SKIP_POSTINSTALL=1/)
            assert.deepEqual(fixture.downloads(), [])
            assert.deepEqual(snapshot(fixture.baroBin), before)
        })
    })
})
