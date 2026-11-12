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
import { execFileSync } from "child_process"
import { semverLt } from "../bin/self-update.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const PACKAGE_ROOT = path.resolve(__dirname, "..")
// Under `sudo npm i -g`, os.homedir() is root's: the bundles would land where
// the person's `baro` never looks, and their old copy keeps running (#176).
function installHome() {
    const sudoUser = process.env.SUDO_USER
    if (sudoUser && typeof process.getuid === "function" && process.getuid() === 0) {
        try {
            const home = execFileSync("sh", ["-c", `eval echo ~${sudoUser}`], { encoding: "utf8" }).trim()
            if (home && home !== "/" && fs.existsSync(home)) return home
        } catch {
            /* fall through to root's home */
        }
    }
    return os.homedir()
}
const BARO_HOME = path.join(installHome(), ".baro", "bin")
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

const IDLE_TIMEOUT_MS = 30_000
const TOTAL_TIMEOUT_MS = 5 * 60_000
const ATTEMPTS = 3

// A stalled connection used to hang install forever after the old binary was
// already gone; every attempt now has an idle and a total deadline.
function download(url, dest) {
    return new Promise((resolve, reject) => {
        let request
        const deadline = setTimeout(() => {
            if (request) request.destroy(new Error(`download exceeded ${TOTAL_TIMEOUT_MS / 1000}s`))
        }, TOTAL_TIMEOUT_MS)
        const fail = (err) => { clearTimeout(deadline); reject(err) }
        const follow = (url, redirects) => {
            request = https.get(url, { headers: { "User-Agent": "baro-cli" } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume()
                    if (redirects >= 5) return fail(new Error(`too many redirects from ${url}`))
                    follow(res.headers.location, redirects + 1)
                    return
                }
                if (res.statusCode !== 200) {
                    res.resume()
                    fail(new Error(`Download failed: ${res.statusCode} from ${url}`))
                    return
                }
                const file = fs.createWriteStream(dest)
                res.pipe(file)
                res.on("error", fail)
                file.on("finish", () => { clearTimeout(deadline); file.close(() => resolve()) })
                file.on("error", fail)
            })
            request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new Error(`no data for ${IDLE_TIMEOUT_MS / 1000}s`)))
            request.on("error", fail)
        }
        follow(url, 0)
    })
}

async function downloadWithRetry(url, dest) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await download(url, dest)
        } catch (err) {
            try { fs.unlinkSync(dest) } catch {}
            if (attempt >= ATTEMPTS) throw err
            console.warn(`Download attempt ${attempt} failed (${err.message}); retrying...`)
            await new Promise((r) => setTimeout(r, 2000 * attempt))
        }
    }
}

// The bundle stamp can disagree with the binary (the #262 breakage left a
// 0.130 binary beside 0.132 bundles); the binary is what is being replaced.
function installedBinaryVersion(binaryPath) {
    if (!fs.existsSync(binaryPath)) return null
    try {
        const out = execFileSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
        return out.match(/\d+\.\d+\.\d+/)?.[0] ?? null
    } catch {
        return null
    }
}

/** Why this install must leave ~/.baro/bin alone, or null to install.
 *  `installedVersion` is a thunk so a skipped install never runs the binary. */
function skipInstallReason({ packageRoot, version, installedVersion, env, baroHome }) {
    if (env.BARO_SKIP_POSTINSTALL === "1") {
        return `baro: BARO_SKIP_POSTINSTALL=1, left ${baroHome} untouched`
    }
    // A checkout's version is whatever commit is checked out, and it has no
    // built bundles: installing from it downgrades or half-replaces the user's baro.
    if (!packageRoot.split(/[\\/]/).includes("node_modules")) {
        return `baro: source checkout, left ${baroHome} untouched; build the binary with \`cargo build --release -p baro-tui\``
    }
    const installed = installedVersion()
    if (installed && semverLt(version, installed) && env.BARO_ALLOW_DOWNGRADE !== "1") {
        return `baro: kept the installed baro ${installed}, newer than baro-ai ${version}; set BARO_ALLOW_DOWNGRADE=1 to install ${version} anyway`
    }
    return null
}

async function main() {
    const binaryPath = path.join(BARO_HOME, BINARY_NAME)
    const version = getVersion()
    const skip = skipInstallReason({
        packageRoot: PACKAGE_ROOT,
        version,
        installedVersion: () => installedBinaryVersion(binaryPath),
        env: process.env,
        baroHome: BARO_HOME,
    })
    if (skip) {
        console.log(skip)
        return
    }
    const platformKey = getPlatformKey()

    const artifactName = process.platform === "win32"
        ? `baro-${platformKey}.exe`
        : `baro-${platformKey}`
    const url = `https://github.com/${REPO}/releases/download/v${version}/${artifactName}`

    console.log(`Downloading baro for ${platformKey}...`)

    fs.mkdirSync(BARO_HOME, { recursive: true })

    // Download beside the old binary first, so a failed download keeps it.
    const partial = `${binaryPath}.download`
    const hadBinary = fs.existsSync(binaryPath)
    let downloaded = false
    try {
        await downloadWithRetry(url, partial)
        if (process.platform !== "win32") {
            fs.chmodSync(partial, 0o755)
        }
        // Windows cannot delete a running executable but can rename it, so an
        // update started from baro itself moves it aside.
        try {
            fs.unlinkSync(binaryPath)
        } catch (err) {
            if (err.code !== "ENOENT") {
                const aside = `${binaryPath}.old`
                try { fs.unlinkSync(aside) } catch {}
                try { fs.renameSync(binaryPath, aside) } catch {}
            }
        }
        fs.renameSync(partial, binaryPath)
        downloaded = true
        console.log(`baro installed to ${BARO_HOME}`)
    } catch (err) {
        console.warn(`Warning: Could not download baro: ${err.message}`)
        console.warn(`  Build manually: cargo build --release -p baro-tui`)
    }

    // The old binary only runs with its own bundles: staging this release's
    // next to it would leave a pair that refuses to start. Keep the whole old
    // install instead, and say how to finish the update.
    if (!downloaded && hadBinary) {
        console.warn(`Warning: kept the installed baro unchanged; this release (${version}) is not installed.`)
        console.warn(`  Retry when github.com is reachable: npm install -g baro-ai@${version} (or npm rebuild baro-ai)`)
        wireMemoryDeps()
        return
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
    let staged = 0
    for (const name of bundles) {
        const src = path.join(distDir, name)
        const dst = path.join(BARO_HOME, name)
        try {
            fs.copyFileSync(src, dst)
            staged += 1
            console.log(`${name} installed to ${dst}`)
        } catch (err) {
            console.warn(`Warning: Could not stage ${name}: ${err.message}`)
        }
    }
    if (process.env.SUDO_UID && process.env.SUDO_GID && typeof process.getuid === "function" && process.getuid() === 0) {
        try {
            const uid = Number(process.env.SUDO_UID)
            const gid = Number(process.env.SUDO_GID)
            for (const name of fs.readdirSync(BARO_HOME)) fs.lchownSync(path.join(BARO_HOME, name), uid, gid)
            fs.chownSync(BARO_HOME, uid, gid)
        } catch (err) {
            console.warn(`Warning: could not hand ${BARO_HOME} back to ${process.env.SUDO_USER}: ${err.message}`)
        }
    }
    // The Rust host compares this stamp with its own version before it runs a
    // bundle, so a binary paired with bundles from another release refuses to
    // start instead of silently running old code (#176).
    if (staged === bundles.length && bundles.length > 0) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"))
            fs.writeFileSync(
                path.join(BARO_HOME, "bundle-version.json"),
                JSON.stringify({ version: pkg.version, stagedAt: new Date().toISOString() }) + "\n",
            )
        } catch (err) {
            console.warn(`Warning: Could not write bundle-version.json: ${err.message}`)
        }
    } else if (bundles.length > 0) {
        console.warn(`Warning: only ${staged}/${bundles.length} bundles staged; baro will refuse to run until \`npm install -g baro-ai\` completes`)
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
/** Whether this install may point the shared link at its own node_modules.
 *  A link that still resolves belongs to whoever made it; only an absent or
 *  dangling one is ours to write. */
export function shouldClaimLink(existing, desired, exists) {
    if (existing === null) return true
    if (existing === desired) return false
    return !exists(existing)
}

/** Where a link points, or null if it is absent or not a link. A dangling
 *  link answers with its target: a broken link is ours to replace. */
function readLinkTarget(link) {
    try {
        return fs.readlinkSync(link)
    } catch {
        return null
    }
}

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
        // ~/.baro/bin is shared user-global state, and an install can run from
        // a copy that will not outlive it — a git worktree in a temp dir, a CI
        // scratch checkout, an agent building this repo. Claiming the link from
        // there points the user's whole installation at a directory about to be
        // deleted, and nothing notices until the next run cannot start. So:
        // repair, never reassign.
        const existing = readLinkTarget(link)
        if (!shouldClaimLink(existing, realNodeModules, (p) => fs.existsSync(p))) {
            if (existing !== realNodeModules) {
                console.log(`memory deps already linked: ${link} -> ${existing}`)
            }
            return
        }
        try { fs.rmSync(link, { recursive: true, force: true }) } catch {}
        fs.symlinkSync(realNodeModules, link, process.platform === "win32" ? "junction" : "dir")
        console.log(`memory deps linked: ${link} -> ${realNodeModules}`)
    } catch (err) {
        console.warn(`Warning: could not wire memory deps (semantic memory may be unavailable): ${err.message}`)
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main()
}
