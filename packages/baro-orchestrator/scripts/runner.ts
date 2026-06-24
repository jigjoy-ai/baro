// `baro connect` runner: pairs with the baro-cloud control plane and runs each
// dispatched goal via `baro --headless` over the user's subscription, streaming
// events back. Bundled into baro-ai as runner.mjs and spawned by `baro connect`.
// Self-contained: the wire protocol is vendored (mirrors @jigjoy-ai/baro-protocol).

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
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
const token = process.env.RUNNER_TOKEN
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
            ws.send(encode({ t: "register", runnerId, hostname: hostname(), token, backends: ["claude"], workspaceIds: ["default"], version: "0.56.3" }))
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
    if (!token) console.warn("[baro] warning: no --token — this runner won't be paired to your account")
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
