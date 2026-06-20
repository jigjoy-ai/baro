// `baro connect` runner: pairs with the baro-cloud control plane and runs each
// dispatched goal via `baro --headless` over the user's subscription, streaming
// events back. Bundled into baro-ai as runner.mjs and spawned by `baro connect`.
// Self-contained: the wire protocol is vendored (mirrors @jigjoy-ai/baro-protocol).

import { spawn } from "node:child_process"
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
}
type ToRunner = RunDispatchMsg | { t: "cancel"; storyId: string } | { t: "ping"; ts: number } | { t: string }

const encode = (m: unknown): string => JSON.stringify(m)

const url = process.env.CONTROL_URL ?? "wss://api.baro.jigjoy.ai"
const token = process.env.RUNNER_TOKEN
const workspaceDir = process.env.WORKSPACE_DIR ?? process.cwd()
const baroBin = process.env.BARO_BIN ?? "baro"
const runnerId = process.env.RUNNER_ID ?? `runner-${process.pid}`

interface RunOutcome {
    success: boolean
    durationSecs: number
    storiesPassed?: number
    storiesTotal?: number
    error: string | null
}

// Run one dispatched goal headless and forward its native event stream.
function runGoal(d: RunDispatchMsg, emit: (e: WireEvent) => void, signal: AbortSignal): Promise<RunOutcome> {
    return new Promise((resolve) => {
        // Use the subscription login, not API billing: a stray ANTHROPIC_API_KEY
        // makes the claude CLI use API auth. Strip it for the child.
        const env = { ...process.env }
        delete env.ANTHROPIC_API_KEY

        const child = spawn(
            baroBin,
            ["--headless", d.goal, "--cwd", workspaceDir, "--llm", d.route?.backend ?? "claude", "--parallel", String(d.parallel), "--timeout", String(d.timeoutSecs)],
            { cwd: workspaceDir, env, stdio: ["ignore", "pipe", "pipe"] },
        )

        const started = Date.now()
        const secs = () => Math.max(1, Math.round((Date.now() - started) / 1000))
        const stories = new Set<string>()
        let passed = 0
        let failed = 0
        let doneSuccess: boolean | null = null

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
        child.stderr?.on("data", () => {})
        signal.addEventListener("abort", () => child.kill("SIGTERM"))
        child.on("close", (code) =>
            resolve({
                success: doneSuccess ?? (code === 0 && failed === 0 && passed > 0),
                durationSecs: secs(),
                storiesPassed: passed,
                storiesTotal: stories.size || passed + failed,
                error: doneSuccess === false ? "run reported failure" : code === 0 ? null : `exit ${code}`,
            }),
        )
        child.on("error", (e) => resolve({ success: false, durationSecs: secs(), error: e.message }))
    })
}

// One connection: register, handle dispatches, resolve when the socket closes
// (so the outer loop reconnects). Control-plane pings keep it alive between runs.
function connectOnce(): Promise<void> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url)
        const inflight = new Map<string, AbortController>()
        ws.on("open", () => {
            ws.send(encode({ t: "register", runnerId, token, backends: ["claude"], workspaceIds: ["default"], version: "0.55.0" }))
            console.log(`[baro] connected to ${url} — workspace ${workspaceDir}`)
        })
        ws.on("message", (data: Buffer) => {
            let m: ToRunner
            try {
                m = JSON.parse(data.toString())
            } catch {
                return
            }
            if (m.t === "ping") {
                ws.send(encode({ t: "pong", ts: (m as { ts: number }).ts }))
            } else if (m.t === "cancel") {
                inflight.get((m as { storyId: string }).storyId)?.abort()
            } else if (m.t === "dispatch_run") {
                const d = m as RunDispatchMsg
                const ac = new AbortController()
                inflight.set(d.runId, ac)
                console.log(`[baro] run ${d.runId}: ${d.goal.split("\n")[0]}`)
                const emit = (event: WireEvent) => ws.send(encode({ t: "event", storyId: event.agentId, event }))
                void runGoal(d, emit, ac.signal).then((o) => {
                    ws.send(encode({ t: "run_result", runId: d.runId, ...o }))
                    inflight.delete(d.runId)
                    console.log(`[baro] run ${d.runId}: ${o.success ? "done" : "failed"} (${o.durationSecs}s)`)
                })
            }
        })
        ws.on("close", () => {
            console.log("[baro] disconnected; reconnecting in 2s…")
            resolve()
        })
        ws.on("error", (e: Error) => console.error("[baro] ws error:", e.message))
    })
}

async function main() {
    if (!token) console.warn("[baro] warning: no --token — this runner won't be paired to your account")
    for (;;) {
        await connectOnce()
        await new Promise((r) => setTimeout(r, 2000))
    }
}

void main()
