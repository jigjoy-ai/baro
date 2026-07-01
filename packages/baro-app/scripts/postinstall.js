#!/usr/bin/env node
/**
 * Postinstall script - downloads the baro binary for the current platform.
 * Binary is stored in ~/.baro/bin/ (outside the npm package directory)
 * to avoid ENOTEMPTY errors when npm upgrades the package.
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import { createRequire } from "module"
import * as https from "https"
import * as os from "os"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
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

    wireMemoryDeps()
    printUsage()
}

/**
 * Short "you're ready — here's how to start" banner, printed once after install.
 * npm shows top-level (global) install-script output, so `npm i -g baro-ai` users
 * see this. Best-effort: purely cosmetic, must never affect the install.
 */
function printUsage() {
    const A = "\x1b[38;5;214m" // amber
    const B = "\x1b[1m"
    const D = "\x1b[2m"
    const R = "\x1b[0m"
    console.log(`
  ${B}baro is ready.${R}

    ${A}baro "add JWT auth with refresh tokens"${R}   plan a goal → a fleet of agents → a PR
    ${A}baro --continue${R}                            follow up on the last run, in place
    ${A}baro connect${R}                               pair this machine with baro's cloud
    ${A}baro --help${R}                                all commands & flags

  ${D}Runs on the Claude or Codex CLI you already have. Docs: https://docs.baro.rs${R}
`)
}

/**
 * Make the externalized embedding stack (`@xenova/transformers` + friends)
 * resolvable from the staged bundles in ~/.baro/bin.
 *
 * The bundles run from ~/.baro/bin/cli.mjs, detached from baro-ai's own
 * node_modules, so a runtime `import("@xenova/transformers")` would walk
 * ~/.baro/bin/node_modules → ~/.baro/node_modules → … and find nothing —
 * which is exactly why semantic memory silently failed to load before.
 * We point ~/.baro/bin/node_modules at the real node_modules that holds
 * @xenova (and its hoisted siblings), so the dynamic import resolves.
 * Best-effort: if it can't be wired, memory is simply unavailable (the
 * MemoryLibrarian already degrades gracefully) — never fail the install.
 */
function wireMemoryDeps() {
    try {
        const entry = require.resolve("@xenova/transformers", { paths: [PACKAGE_ROOT] })
        const marker = `${path.sep}node_modules${path.sep}`
        const idx = entry.lastIndexOf(marker)
        if (idx === -1) {
            console.warn("Warning: @xenova/transformers not under a node_modules dir; skipping memory wiring")
            return
        }
        const realNodeModules = entry.slice(0, idx + marker.length - 1) // .../node_modules
        const link = path.join(BARO_HOME, "node_modules")
        try { fs.rmSync(link, { recursive: true, force: true }) } catch {}
        fs.symlinkSync(realNodeModules, link, process.platform === "win32" ? "junction" : "dir")
        console.log(`memory deps linked: ${link} -> ${realNodeModules}`)
    } catch (err) {
        console.warn(`Warning: could not wire memory deps (semantic memory may be unavailable): ${err.message}`)
    }
}

main()
