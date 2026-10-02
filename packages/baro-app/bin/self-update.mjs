// A hand-started baro brings itself up to date before it runs. The runner
// already did this for services; a person running `baro` stayed on whatever
// they had installed until they noticed the banner.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const CACHE_TTL_MS = 3 * 3600_000
const FETCH_TIMEOUT_MS = 2500
const QUICK_COMMANDS = new Set(["--version", "-V", "--help", "-h", "connect"])

export function semverLt(a, b) {
    const parts = (v) => String(v).split(".").map((x) => Number.parseInt(x, 10) || 0)
    const [pa, pb] = [parts(a), parts(b)]
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
    }
    return false
}

/**
 * Why this invocation must not update, or null when it may. Automation keeps
 * the version it was given; the runner updates itself between runs; and the
 * staged bundles are shared, so replacing them under a live run breaks it.
 */
export function skipReason({ argv, env, isTTY, liveRuns }) {
    if (env.BARO_NO_SELF_UPDATE === "1") return "BARO_NO_SELF_UPDATE=1"
    if (env.CI) return "CI"
    if (!isTTY) return "not a terminal"
    if (argv.includes("--headless")) return "headless"
    if (argv.some((arg) => QUICK_COMMANDS.has(arg))) return "quick command"
    if (liveRuns > 0) return "another baro run is active"
    return null
}

function baroHome() {
    return path.join(homedir(), ".baro")
}

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8"))
    } catch {
        return null
    }
}

/** The version the binary and its bundles are actually staged at. */
export function installedVersion(packageVersion) {
    return readJson(path.join(baroHome(), "bin", "bundle-version.json"))?.version ?? packageVersion
}

export function liveRunCount() {
    try {
        const dir = path.join(baroHome(), "live")
        return readdirSync(dir).filter((name) => {
            const pid = readJson(path.join(dir, name))?.pid
            if (!Number.isInteger(pid)) return false
            try {
                process.kill(pid, 0)
                return true
            } catch (error) {
                return error.code === "EPERM"
            }
        }).length
    } catch {
        return 0
    }
}

export async function latestVersion(now = Date.now()) {
    const cachePath = path.join(baroHome(), "update-check.json")
    const cached = readJson(cachePath)
    if (cached?.latest && cached.checkedAt && now - cached.checkedAt < CACHE_TTL_MS) {
        return cached.latest
    }
    try {
        const response = await fetch("https://registry.npmjs.org/baro-ai/latest", {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        const latest = (await response.json())?.version
        if (typeof latest !== "string") return null
        try {
            mkdirSync(baroHome(), { recursive: true })
            writeFileSync(cachePath, JSON.stringify({ latest, checkedAt: now }))
        } catch {
            // A read-only home only costs the next start another lookup.
        }
        return latest
    } catch {
        return null
    }
}

/**
 * Update when a newer baro is published. Never throws and never blocks a run
 * for long: offline, a failed install or a root-owned global prefix all fall
 * through to the version already installed.
 */
export async function selfUpdate({ packageVersion, argv, env = process.env, isTTY = process.stdin.isTTY }) {
    const reason = skipReason({ argv, env, isTTY: Boolean(isTTY), liveRuns: 0 })
    if (reason) return { updated: false, reason }
    const current = installedVersion(packageVersion)
    const latest = await latestVersion()
    if (!latest || !semverLt(current, latest)) return { updated: false, reason: "up to date" }
    if (liveRunCount() > 0) {
        console.error(`baro ${latest} is available; not updating while another baro run is active.`)
        return { updated: false, reason: "another baro run is active" }
    }
    console.error(`Updating baro ${current} → ${latest}…`)
    const result = spawnSync("npm", ["install", "-g", `baro-ai@${latest}`], {
        stdio: ["ignore", "ignore", "inherit"],
        shell: process.platform === "win32",
    })
    if (result.status !== 0 || installedVersion(packageVersion) !== latest) {
        console.error(`Could not update baro automatically. Update with: npm i -g baro-ai@latest`)
        return { updated: false, reason: "install failed" }
    }
    console.error(`baro ${latest} installed.`)
    return { updated: true, reason: null }
}
