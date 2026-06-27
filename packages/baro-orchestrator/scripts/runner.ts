// `baro connect` runner: pairs with the baro-cloud control plane and runs each
// dispatched goal via `baro --headless` over the user's subscription, streaming
// events back. Bundled into baro-ai as runner.mjs and spawned by `baro connect`.
// Self-contained: the wire protocol is vendored (mirrors @jigjoy-ai/baro-protocol).

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"

interface WireEvent {
    type: string
    data: unknown
    agentId: string
}
interface RunDispatchMsg {
    t: "dispatch_run"
    runId: string
    goal: string
    workspaceId: string
    parallel: number
    timeoutSecs: number
    route?: { backend?: string; model?: string }
    // When present, clone this repo (with the token) and run there so baro opens
    // a PR; otherwise run in the local --workspace dir.
    repo?: { fullName: string }
    githubToken?: string
}
type ToRunner = RunDispatchMsg | { t: "cancel"; storyId: string } | { t: "ping"; ts: number } | { t: "rejected"; reason: string } | { t: string }

const encode = (m: unknown): string => JSON.stringify(m)

const url = process.env.CONTROL_URL ?? "wss://api.baro.jigjoy.ai"
let token = process.env.RUNNER_TOKEN

// The HTTP origin of the control plane (the WS url with the scheme swapped) — used by
// `baro login` and runner self-registration. wss://host → https://host.
const httpBase = url.replace(/^ws/, "http").replace(/\/+$/, "")
const credsPath = join(homedir(), ".baro", "credentials.json")

const VERSION = "0.58.1"
const updateCachePath = join(homedir(), ".baro", "update-check.json")

// a.b.c < x.y.z, numeric per-segment.
function semverLt(a: string, b: string): boolean {
    const pa = a.split(".").map(Number)
    const pb = b.split(".").map(Number)
    for (let i = 0; i < 3; i++) {
        const x = pa[i] ?? 0
        const y = pb[i] ?? 0
        if (x !== y) return x < y
    }
    return false
}

// Latest published baro-ai version, cached ~24h in ~/.baro so we don't hit npm on every
// start. The cache file is ALSO what the Rust binary reads to print its update banner —
// one network check (here) serves both the runner self-update and the interactive notice.
async function getLatest(force = false): Promise<string | null> {
    if (!force) {
        try {
            const c = JSON.parse(readFileSync(updateCachePath, "utf8")) as { latest?: string; checkedAt?: number }
            if (c.latest && c.checkedAt && Date.now() - c.checkedAt < 24 * 3600_000) return c.latest
        } catch {
            /* no/!stale cache → fetch */
        }
    }
    try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 4000)
        const r = await fetch("https://registry.npmjs.org/baro-ai/latest", { signal: ctrl.signal })
        clearTimeout(t)
        const latest = ((await r.json()) as { version?: string }).version
        if (!latest) return null
        try {
            mkdirSync(join(homedir(), ".baro"), { recursive: true })
            writeFileSync(updateCachePath, JSON.stringify({ latest, checkedAt: Date.now() }))
        } catch {
            /* best-effort cache */
        }
        return latest
    } catch {
        return null
    }
}

// Pull the new version in place. Returns true on success. Best-effort: a sudo/perms
// failure (global install owned by root) is reported, never fatal.
async function selfUpdate(latest: string): Promise<boolean> {
    return await new Promise((resolve) => {
        console.log(`[baro] updating ${VERSION} → ${latest}…`)
        const child = spawn("npm", ["install", "-g", `baro-ai@${latest}`], { stdio: "inherit", shell: process.platform === "win32" })
        child.on("exit", (code) => resolve(code === 0))
        child.on("error", () => resolve(false))
    })
}

const readCliToken = (): string | undefined => {
    try {
        return (JSON.parse(readFileSync(credsPath, "utf8")) as { token?: string }).token
    } catch {
        return undefined
    }
}

const openBrowser = (target: string): void => {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    try {
        spawn(cmd, [target], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref()
    } catch {
        /* best-effort — the URL is printed too */
    }
}

// `baro login`: device flow. Ask for a code, open the browser to approve it, poll until
// the control plane mints a long-lived cli_ token, then store it under ~/.baro.
async function login(): Promise<void> {
    const start = (await (await fetch(`${httpBase}/cli/auth/start`, { method: "POST" })).json()) as {
        deviceCode: string
        userCode: string
        verifyUrl: string
    }
    console.log(`\n  Opening your browser to sign in. If it doesn't open, visit:\n  ${start.verifyUrl}\n\n  Confirm this code matches:  ${start.userCode}\n`)
    openBrowser(start.verifyUrl)
    for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        const r = (await (await fetch(`${httpBase}/cli/auth/poll?deviceCode=${start.deviceCode}`)).json()) as { status: string; token?: string }
        if (r.status === "approved" && r.token) {
            mkdirSync(join(homedir(), ".baro"), { recursive: true })
            writeFileSync(credsPath, JSON.stringify({ token: r.token, controlUrl: url }, null, 2), { mode: 0o600 })
            console.log("  ✓ Signed in. Run `baro connect` to pair this machine.\n")
            return
        }
        if (r.status === "expired") throw new Error("login code expired — run `baro login` again")
    }
}
const workspaceDir = process.env.WORKSPACE_DIR ?? process.cwd()
const baroBin = process.env.BARO_BIN ?? "baro"
// Stable per-machine id so the control plane can show one runner across
// reconnects (not a new entry each time), plus a human-readable hostname.
const runnerId = process.env.RUNNER_ID ?? hostname()
// Single-run mode for ephemeral cloud workers (Fargate): take one dispatched run,
// deliver its result, then exit — no reconnect loop.
const runOnce = process.env.BARO_RUN_ONCE === "1"

interface RunOutcome {
    success: boolean
    durationSecs: number
    storiesPassed?: number
    storiesTotal?: number
    error: string | null
}

// Clone a repo into a fresh temp dir using the user's OAuth token; returns the dir.
function cloneRepo(fullName: string, token: string, emit: (e: WireEvent) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        const dir = mkdtempSync(join(tmpdir(), "baro-clone-"))
        const url = `https://x-access-token:${token}@github.com/${fullName}.git`
        emit({ type: "story_log", agentId: "_git", data: { type: "story_log", id: "_git", line: `cloning ${fullName}…` } })
        const ch = spawn("git", ["clone", "--quiet", url, dir], { stdio: "ignore" })
        ch.on("close", (code) => (code === 0 ? resolve(dir) : reject(new Error(`git clone exit ${code}`))))
        ch.on("error", reject)
    })
}

// Run one dispatched goal headless and forward its native event stream. With a
// repo, clone it (token auth) and run there so baro pushes + opens a PR.
async function runGoal(d: RunDispatchMsg, emit: (e: WireEvent) => void, signal: AbortSignal): Promise<RunOutcome> {
    // Use the subscription login, not API billing: a stray ANTHROPIC_API_KEY
    // makes the claude CLI use API auth. Strip it for the child.
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.ANTHROPIC_API_KEY

    let cwd = workspaceDir
    let cleanup: (() => void) | undefined
    if (d.repo && d.githubToken) {
        try {
            cwd = await cloneRepo(d.repo.fullName, d.githubToken, emit)
        } catch (e) {
            return { success: false, durationSecs: 1, error: `clone failed: ${(e as Error).message}` }
        }
        // Let baro's git push + `gh pr create` authenticate as the user.
        env.GH_TOKEN = d.githubToken
        env.GITHUB_TOKEN = d.githubToken
        cleanup = () => {
            try {
                rmSync(cwd, { recursive: true, force: true })
            } catch {
                // best-effort
            }
        }
    }

    const outcome = await new Promise<RunOutcome>((resolve) => {
        // Planning + execution use baro's own model routing (Architect/Planner on
        // the latest opus for the claude backend) — we don't override it.
        const child = spawn(
            baroBin,
            ["--headless", d.goal, "--cwd", cwd, "--llm", d.route?.backend ?? "claude", "--parallel", String(d.parallel), "--timeout", String(d.timeoutSecs)],
            { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
        )

        const started = Date.now()
        const secs = () => Math.max(1, Math.round((Date.now() - started) / 1000))
        const stories = new Set<string>()
        let passed = 0
        let failed = 0
        let doneSuccess: boolean | null = null
        let stderrTail = ""

        let buf = ""
        child.stdout?.on("data", (chunk: Buffer) => {
            buf += chunk.toString()
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim()
                buf = buf.slice(nl + 1)
                if (!line) continue
                let ev: Record<string, unknown>
                try {
                    ev = JSON.parse(line)
                } catch {
                    continue
                }
                const sid = String(ev.id ?? ev.storyId ?? ev.story_id ?? d.runId)
                if (sid !== d.runId && !sid.startsWith("_")) stories.add(sid)
                emit({ type: String(ev.type ?? "baro_event"), agentId: sid, data: ev })
                if (ev.type === "story_complete") passed++
                else if (ev.type === "story_error") failed++
                else if (ev.type === "done") doneSuccess = !!ev.success
            }
        })
        // Keep the tail of stderr so a failure carries the real cause back to
        // the cloud (e.g. "planner FAILED: claude … model opus") instead of a
        // bare exit code — otherwise failures are invisible in the dashboard.
        child.stderr?.on("data", (chunk: Buffer) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-4000)
        })
        signal.addEventListener("abort", () => child.kill("SIGTERM"))
        child.on("close", (code) => {
            const ok = doneSuccess ?? (code === 0 && failed === 0 && passed > 0)
            const errTail = stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" · ").slice(-500)
            resolve({
                success: ok,
                durationSecs: secs(),
                storiesPassed: passed,
                storiesTotal: stories.size || passed + failed,
                error: ok ? null : errTail || (doneSuccess === false ? "run reported failure" : `exit ${code}`),
            })
        })
        child.on("error", (e) => resolve({ success: false, durationSecs: secs(), error: e.message }))
    })
    cleanup?.()
    return outcome
}

// Set when the control plane refuses us (bad/expired token): stop the reconnect
// loop instead of hammering it forever with a token that will never resolve.
let rejected: string | undefined

// The live socket. An in-flight run streams through *this*, not the socket it
// started on, so events + run_result keep flowing after a reconnect: the control
// plane re-attaches by runnerId and only fails the run after a grace window. A
// brief network blip mid-run no longer kills work that's still executing here.
let currentWs: WebSocket | null = null
const inflight = new Map<string, AbortController>()
const send = (m: unknown): void => {
    if (currentWs?.readyState === WebSocket.OPEN) currentWs.send(encode(m))
}

function handleMessage(m: ToRunner): void {
    if (m.t === "rejected") {
        rejected = (m as { reason?: string }).reason ?? "unknown reason"
        console.error(`[baro] control plane rejected this runner: ${rejected}`)
        currentWs?.close()
    } else if (m.t === "ping") {
        send({ t: "pong", ts: (m as { ts: number }).ts })
    } else if (m.t === "cancel") {
        inflight.get((m as { storyId: string }).storyId)?.abort()
    } else if (m.t === "dispatch_run") {
        const d = m as RunDispatchMsg
        if (inflight.has(d.runId)) return // already running — ignore a duplicate dispatch
        const ac = new AbortController()
        inflight.set(d.runId, ac)
        console.log(`[baro] run ${d.runId}: ${d.goal.split("\n")[0]}`)
        const emit = (event: WireEvent) => send({ t: "event", storyId: event.agentId, event })
        void runGoal(d, emit, ac.signal).then((o) => {
            send({ t: "run_result", runId: d.runId, ...o })
            inflight.delete(d.runId)
            console.log(`[baro] run ${d.runId}: ${o.success ? "done" : "failed"} (${o.durationSecs}s)`)
            // Ephemeral worker: deliver the result, give the socket a moment to
            // flush, then exit so the Fargate task tears down.
            if (runOnce) {
                setTimeout(() => {
                    currentWs?.close()
                    process.exit(o.success ? 0 : 1)
                }, 1500)
            }
        })
    }
}

// One connection: register, then resolve when the socket closes so the outer loop
// reconnects. Any in-flight run keeps streaming through `currentWs` across the gap.
function connectOnce(): Promise<void> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url)
        currentWs = ws
        ws.on("open", () => {
            ws.send(encode({ t: "register", runnerId, hostname: hostname(), token, backends: ["claude"], workspaceIds: ["default"], version: VERSION }))
            console.log(inflight.size ? `[baro] reconnected to ${url} — resuming ${inflight.size} in-flight run(s)` : `[baro] connected to ${url} — workspace ${workspaceDir}`)
        })
        ws.on("message", (data: Buffer) => {
            let m: ToRunner
            try {
                m = JSON.parse(data.toString())
            } catch {
                return
            }
            handleMessage(m)
        })
        ws.on("close", () => {
            console.log(inflight.size ? "[baro] disconnected mid-run; reconnecting in 2s…" : "[baro] disconnected; reconnecting in 2s…")
            resolve()
        })
        ws.on("error", (e: Error) => console.error("[baro] ws error:", e.message))
    })
}

async function main() {
    if (process.env.BARO_LOGIN === "1") {
        await login()
        return
    }
    // Refresh-only mode: the Rust binary spawns this in the background so the update
    // cache stays fresh for its banner, even when baro is only used interactively.
    if (process.env.BARO_CHECK_UPDATE === "1") {
        await getLatest(true)
        return
    }
    // Keep runners current. We release often and a stale runner re-runs bugs we've already
    // fixed (e.g. the worktree dep-sharing fix). Check npm; if behind, self-update under a
    // background service (it restarts into the new version) or just notify in foreground.
    try {
        const latest = await getLatest()
        if (latest && semverLt(VERSION, latest)) {
            if (process.env.BARO_SERVICE === "1") {
                if (await selfUpdate(latest)) {
                    console.log(`[baro] updated to ${latest} — restarting service…`)
                    process.exit(0) // launchd/systemd/Task Scheduler relaunches with the new version
                }
                console.warn(`[baro] could not self-update (likely a root-owned global install). Update manually: npm i -g baro-ai@latest`)
            } else {
                console.warn(`[baro] a newer baro is available (${VERSION} → ${latest}). Update: npm i -g baro-ai`)
            }
        }
    } catch {
        /* never let the update check block the runner */
    }
    // No --token? If `baro login` left credentials, register a runner with them — no
    // dashboard visit, no token to paste.
    if (!token) {
        const cli = readCliToken()
        if (cli) {
            try {
                const reg = (await (await fetch(`${httpBase}/cli/runners/register`, { method: "POST", headers: { authorization: `Bearer ${cli}` } })).json()) as { token?: string }
                token = reg.token
            } catch {
                /* fall through to the not-signed-in message */
            }
        }
    }
    if (!token) {
        console.error("[baro] not signed in. Run `baro login` first, or pass --token <rt_…> (get one from the dashboard).")
        process.exit(1)
    }
    // Ephemeral worker safety: if nothing is dispatched within 3 min of starting,
    // exit so an orphaned cloud task (paired but never given work) can't linger.
    if (runOnce) {
        setTimeout(() => {
            if (inflight.size === 0) {
                console.error("[baro] --once: no run dispatched within 180s; exiting")
                process.exit(2)
            }
        }, 180_000)
    }
    for (;;) {
        await connectOnce()
        if (rejected) {
            console.error("[baro] not reconnecting — re-run `baro connect --token rt_…` with a fresh token from the dashboard")
            process.exit(1)
        }
        await new Promise((r) => setTimeout(r, 2000))
    }
}

void main()
