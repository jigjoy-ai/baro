#!/usr/bin/env node
/**
 * Postinstall script - downloads the baro binary for the current platform.
 * Binary is stored in ~/.baro/bin/ (outside the npm package directory)
 * to avoid ENOTEMPTY errors when npm upgrades the package.
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import * as https from "https"
import * as os from "os"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, "..")
const BARO_HOME = path.join(os.homedir(), ".baro", "bin")
const BINARY_NAME = process.platform === "win32" ? "baro.exe" : "baro"
const REPO = "jigjoy-ai/baro"

function getPlatformKey() {
    const platform = process.platform
    const arch = process.arch

    const map = {
        "darwin-arm64": "darwin-arm64",
        "darwin-x64": "darwin-x64",
        "linux-x64": "linux-x64",
        "linux-arm64": "linux-arm64",
        "win32-x64": "windows-x64",
    }

    const key = `${platform}-${arch}`
    if (!map[key]) {
        console.warn(`Warning: no prebuilt baro binary for ${key}.`)
        console.warn(`  You can build it manually: cargo build --release -p baro-tui`)
        process.exit(0)
    }
    return map[key]
}

function getVersion() {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8"))
    return pkg.version
}

async function download(url, dest) {
    return new Promise((resolve, reject) => {
        const follow = (url) => {
            https.get(url, { headers: { "User-Agent": "baro-cli" } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    follow(res.headers.location)
                    return
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`Download failed: ${res.statusCode} from ${url}`))
                    return
                }
                const file = fs.createWriteStream(dest)
                res.pipe(file)
                file.on("finish", () => { file.close(); resolve() })
                file.on("error", reject)
            }).on("error", reject)
        }
        follow(url)
    })
}

async function main() {
    const binaryPath = path.join(BARO_HOME, BINARY_NAME)
    const platformKey = getPlatformKey()
    const version = getVersion()

    const artifactName = process.platform === "win32"
        ? `baro-${platformKey}.exe`
        : `baro-${platformKey}`
    const url = `https://github.com/${REPO}/releases/download/v${version}/${artifactName}`

    console.log(`Downloading baro for ${platformKey}...`)

    fs.mkdirSync(BARO_HOME, { recursive: true })

    // Clean up old binary
    try { fs.unlinkSync(binaryPath) } catch {}

    try {
        await download(url, binaryPath)
        if (process.platform !== "win32") {
            fs.chmodSync(binaryPath, 0o755)
        }
        console.log(`baro installed to ${BARO_HOME}`)
    } catch (err) {
        console.warn(`Warning: Could not download baro: ${err.message}`)
        console.warn(`  Build manually: cargo build --release -p baro-tui`)
    }

    // Stage the bundled TS subprocess code alongside the binary so the
    // Rust runners can find it regardless of how baro-ai was installed
    // (local node_modules, npx, npm install -g …). This lets
    // architect_runner / planner_runner / orchestrator_client hit them
    // via the production fast path (Node, no tsx).
    //
    // Copy EVERY `.mjs` in dist/, not just the three named entry points:
    // tsup may emit shared `chunk-*.mjs` siblings (code-splitting), and
    // an entry that imports a chunk we didn't stage dies at runtime with
    // ERR_MODULE_NOT_FOUND. Globbing all `.mjs` keeps the runners whole
    // even if the bundle layout changes. (Sourcemaps are skipped — not
    // needed at runtime.)
    const distDir = path.join(PACKAGE_ROOT, "dist")
    let bundles = []
    try {
        bundles = fs.readdirSync(distDir).filter((n) => n.endsWith(".mjs"))
    } catch (err) {
        console.warn(`Warning: could not read ${distDir}: ${err.message}`)
    }
    for (const name of bundles) {
        const src = path.join(distDir, name)
        const dst = path.join(BARO_HOME, name)
        try {
            fs.copyFileSync(src, dst)
            console.log(`${name} installed to ${dst}`)
        } catch (err) {
            console.warn(`Warning: Could not stage ${name}: ${err.message}`)
        }
    }
}

main()
