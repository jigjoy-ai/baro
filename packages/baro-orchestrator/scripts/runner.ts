// `baro connect` runner: pairs with the baro-cloud control plane and runs each
// dispatched goal via `baro --headless` over the user's subscription, streaming
// events back. Bundled into baro-ai as runner.mjs and spawned by `baro connect`.
// Self-contained: the wire protocol is vendored (mirrors @jigjoy-ai/baro-protocol).

import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname, homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { WebSocket } from "ws"
import { buildInstallServiceArgs, buildReexec, semverLt } from "./runner-helpers.js"

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
    // No-GitHub preview: clone the (public) repo WITHOUT a token, run, and return the
    // diff instead of opening a PR — so a visitor sees baro's output before connecting.
    diffOnly?: boolean
    // Skip planning (architect + planner) — single-agent fast path for trivial goals.
    quick?: boolean
    // Execution mode for baro's intake (BARO_MODE env — older binaries just ignore it).
    mode?: "auto" | "focused" | "sequential" | "parallel"
    // Follow-up: check out this PR's branch and run with --continue so it updates in place.
    followUp?: { prNumber: number }
}
type ToRunner =
    | RunDispatchMsg
    | { t: "cancel"; storyId: string }
    | { t: "agent_message"; storyId: string; text: string }
    | { t: "ping"; ts: number }
    | { t: "rejected"; reason: string }
    | { t: string }

const encode = (m: unknown): string => JSON.stringify(m)

const url = process.env.CONTROL_URL ?? "wss://api.baro.jigjoy.ai"
let token = process.env.RUNNER_TOKEN

// HTTP origin of the control plane — used by `baro login` and runner self-registration.
const httpBase = url.replace(/^ws/, "http").replace(/\/+$/, "")
const credsPath = join(homedir(), ".baro", "credentials.json")

const VERSION = "0.74.0"
const updateCachePath = join(homedir(), ".baro", "update-check.json")

// Latest published baro-ai version, cached ~24h in ~/.baro so we don't hit npm on every
// start. The cache file is ALSO what the Rust binary reads to print its update banner —
// one network check (here) serves both the runner self-update and the interactive notice.
async function getLatest(force = false): Promise<string | null> {
    if (!force) {
        try {
            const c = JSON.parse(readFileSync(updateCachePath, "utf8")) as { latest?: string; checkedAt?: number }
            if (c.latest && c.checkedAt && Date.now() - c.checkedAt < 3 * 3600_000) return c.latest
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

// Foreground restart after a self-update: the global install now holds the new
// runner.mjs at the same path, so re-running the same script picks it up. The
// child re-pairs with the same credentials/runnerId; we exit when it does.
function reexecUpdated(): void {
    const { cmd, args, env } = buildReexec(process.execPath, process.argv, process.env)
    const child = spawn(cmd, args, { stdio: "inherit", detached: false, env })
    child.on("exit", (code, signal) => process.exit(signal ? 0 : (code ?? 0)))
    child.on("error", (e) => {
        console.error(`[baro] could not restart into the updated runner (${e.message}) — run \`baro connect\` again`)
        process.exit(1)
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
const isService = process.env.BARO_SERVICE === "1"

interface RunOutcome {
    success: boolean
    durationSecs: number
    storiesPassed?: number
    storiesTotal?: number
    error: string | null
    // Set in diffOnly mode: the unified patch of everything baro changed (no PR opened).
    diff?: string
}

// With a token, authenticated clone (private repos + push); without, public clone (diffOnly preview).
function cloneRepo(fullName: string, token: string | undefined, emit: (e: WireEvent) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        const dir = mkdtempSync(join(tmpdir(), "baro-clone-"))
        const url = token ? `https://x-access-token:${token}@github.com/${fullName}.git` : `https://github.com/${fullName}.git`
        emit({ type: "story_log", agentId: "_git", data: { type: "story_log", id: "_git", line: `cloning ${fullName}…` } })
        const ch = spawn("git", ["clone", "--quiet", url, dir], { stdio: "ignore" })
        ch.on("close", (code) => (code === 0 ? resolve(dir) : reject(new Error(`git clone exit ${code}`))))
        ch.on("error", reject)
    })
}

// Keep baro's dep-sharing symlinks (node_modules/.venv/vendor — see worktree.ts) out of the
// PR / patch. Uses the repo-local .git/info/exclude — never the user's tracked .gitignore —
// and worktrees share the common dir's info/exclude, so one write covers them too.
function excludeDepDirs(cwd: string): void {
    try {
        const patterns = ["node_modules", "**/node_modules", ".venv", "**/.venv", "vendor", "**/vendor"]
        appendFileSync(join(cwd, ".git", "info", "exclude"), `\n# baro: dep-sharing symlinks (never commit)\n${patterns.join("\n")}\n`)
    } catch {
        /* best-effort — worst case the symlink shows up as before */
    }
}

// Package manager + ordered install attempts, chosen by lockfile. The frozen
// variant runs first; a loose install is the fallback when it fails. undefined =
// no lockfile, so nothing to install here.
function depCommand(dir: string): { tool: string; attempts: string[][] } | undefined {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return { tool: "pnpm", attempts: [["install", "--frozen-lockfile"], ["install"]] }
    if (existsSync(join(dir, "yarn.lock"))) return { tool: "yarn", attempts: [["install", "--frozen-lockfile"], ["install"]] }
    if (existsSync(join(dir, "package-lock.json"))) return { tool: "npm", attempts: [["ci"], ["install"]] }
    return undefined
}

function installOne(dir: string, cmd: { tool: string; attempts: string[][] }, log: (l: string) => void): void {
    for (let i = 0; i < cmd.attempts.length; i++) {
        try {
            execFileSync(cmd.tool, cmd.attempts[i]!, { cwd: dir, stdio: "ignore", timeout: 4 * 60_000, shell: process.platform === "win32" })
            return
        } catch (e) {
            // Tool not installed → give up on this dir (no fallback can help).
            if ((e as { code?: string }).code === "ENOENT") {
                log(`${cmd.tool} not found — skipping ${dir}`)
                return
            }
            // Frozen install failed → fall through to the loose attempt; only
            // log once every attempt is exhausted.
            if (i === cmd.attempts.length - 1) log(`dependency install failed in ${dir} (${cmd.tool}) — agents will retry`)
        }
    }
}

// A fresh clone has no node_modules, so every story agent would otherwise race to
// `npm install` (one run burned 667k tokens on this) and worktree symlinks would
// point at an empty dir. Pre-install once, up front — repo root plus common
// one-level subdirs — best-effort: failures just log and let agents cope. Clone
// path only; a local in-dir run already has its deps.
function preinstallDeps(root: string, emit: (e: WireEvent) => void): void {
    const log = (line: string) => emit({ type: "story_log", agentId: "_deps", data: { type: "story_log", id: "_deps", line } })
    try {
        const dirs = new Set<string>([root])
        for (const sub of ["backend", "frontend"]) dirs.add(join(root, sub))
        for (const group of ["packages", "apps"]) {
            try {
                for (const name of readdirSync(join(root, group))) dirs.add(join(root, group, name))
            } catch {
                /* group dir absent — skip */
            }
        }
        const targets = [...dirs]
            .filter((d) => existsSync(join(d, "package.json")))
            .map((d) => ({ dir: d, cmd: depCommand(d) }))
            .filter((t): t is { dir: string; cmd: NonNullable<ReturnType<typeof depCommand>> } => t.cmd !== undefined)
        if (targets.length === 0) return
        log("installing dependencies…")
        for (const t of targets) installOne(t.dir, t.cmd, log)
        log("dependencies ready")
    } catch (e) {
        log(`dependency pre-install skipped: ${(e as Error).message}`)
    }
}

function captureDiff(cwd: string, base: string): string {
    try {
        execFileSync("git", ["add", "-A"], { cwd })
        const out = execFileSync("git", ["diff", "--cached", base], { cwd, maxBuffer: 8 * 1024 * 1024 }).toString()
        return out.length > 200_000 ? out.slice(0, 200_000) + "\n… (diff truncated)" : out
    } catch {
        return ""
    }
}

// Run one dispatched goal headless and forward its native event stream. With a
// repo, clone it (token auth) and run there so baro pushes + opens a PR.
async function runGoal(d: RunDispatchMsg, emit: (e: WireEvent) => void, signal: AbortSignal): Promise<RunOutcome> {
    // Use the subscription login, not API billing: a stray ANTHROPIC_API_KEY
    // makes the claude CLI use API auth. Strip it for the child.
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    if (d.mode) env.BARO_MODE = d.mode

    let cwd = workspaceDir
    let cleanup: (() => void) | undefined
    let diffBase: string | undefined
    let scratch = false
    let prUrl: string | null = null
    if (d.repo && (d.githubToken || d.diffOnly)) {
        try {
            // diffOnly → public clone (no token); otherwise authenticated (private + push).
            cwd = await cloneRepo(d.repo.fullName, d.githubToken, emit)
        } catch (e) {
            return { success: false, durationSecs: 1, error: `clone failed: ${(e as Error).message}` }
        }
        excludeDepDirs(cwd)
        // Populate the shared node_modules before worktrees symlink to it and
        // before agents run. Non-fatal — see preinstallDeps.
        preinstallDeps(cwd, emit)
        if (d.diffOnly) {
            // Drop the origin remote so baro skips ALL push/PR steps cleanly ("no remote,
            // skipping push") instead of failing them noisily without a token — we return
            // the patch instead. Record the base first to diff baro's work against it.
            try {
                diffBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim()
            } catch {
                diffBase = undefined
            }
            try {
                execFileSync("git", ["remote", "remove", "origin"], { cwd })
            } catch {
                /* best-effort — diff still works; push would just warn */
            }
        } else {
            // Let baro's git push + `gh pr create` authenticate as the user.
            env.GH_TOKEN = d.githubToken
            env.GITHUB_TOKEN = d.githubToken
            // Follow-up: check out the prior run's PR branch so its work is the starting
            // point. baro runs with --continue (below) → commits here → the existing PR
            // updates. If checkout fails (PR closed/merged), fall through to a normal run.
            if (d.followUp?.prNumber) {
                try {
                    execFileSync("gh", ["pr", "checkout", String(d.followUp.prNumber)], { cwd, env })
                    emit({ type: "story_log", agentId: "_git", data: { type: "story_log", id: "_git", line: `continuing on PR #${d.followUp.prNumber}…` } })
                } catch {
                    emit({ type: "story_log", agentId: "_git", data: { type: "story_log", id: "_git", line: `PR #${d.followUp.prNumber} not checkout-able (closed?) — opening a fresh PR` } })
                    d.followUp = undefined // don't pass --continue; let baro open a new PR
                }
            }
        }
        cleanup = () => {
            try {
                rmSync(cwd, { recursive: true, force: true })
            } catch {
                // best-effort
            }
        }
    } else if (!d.repo) {
        // No repo → from-scratch build. The default workspace isn't a git repo, so baro
        // would die on branch creation; give it a git-initialized scratch dir (like the
        // hosted sandbox) and return the result as a patch so the user sees what was built.
        scratch = true
        cwd = mkdtempSync(join(tmpdir(), "baro-scratch-"))
        try {
            const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "baro", GIT_AUTHOR_EMAIL: "baro@baro.rs", GIT_COMMITTER_NAME: "baro", GIT_COMMITTER_EMAIL: "baro@baro.rs" }
            execFileSync("git", ["init", "-q"], { cwd })
            excludeDepDirs(cwd)
            execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "baro: initial workspace"], { cwd, env: gitEnv })
            diffBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim()
        } catch (e) {
            return { success: false, durationSecs: 1, error: `workspace init failed: ${(e as Error).message}` }
        }
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
            ["--headless", d.goal, "--cwd", cwd, "--llm", d.route?.backend ?? "claude", "--parallel", String(d.parallel), "--timeout", String(d.timeoutSecs), ...(d.quick ? ["--quick"] : []), ...(d.followUp ? ["--continue"] : [])],
            // stdin is piped: baro --headless forwards JSON command lines
            // (agent_message) into the orchestrator's stdin lane.
            { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
        )
        activeChild = child

        const started = Date.now()
        const secs = () => Math.max(1, Math.round((Date.now() - started) / 1000))
        const stories = new Set<string>()
        let passed = 0
        let failed = 0
        let doneSuccess: boolean | null = null
        let lastErr = "" // real failure reason from the event stream (beats raw stderr)
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
                else if (ev.type === "finalize_complete") prUrl = ((ev.data as Record<string, unknown> | undefined)?.pr_url as string) ?? (ev.pr_url as string) ?? prUrl
                // Capture the real failure reason from the stream (story/planner/architect
                // errors, or a failed `done`), so we don't fall back to a noisy stderr banner.
                const d2 = (ev.data ?? {}) as Record<string, unknown>
                const msg = d2.error ?? d2.message ?? (ev as Record<string, unknown>).error
                if (typeof msg === "string" && msg.trim() && (String(ev.type).includes("error") || String(ev.type).includes("fail") || (ev.type === "done" && ev.success === false))) {
                    lastErr = msg.trim()
                }
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
            if (activeChild === child) activeChild = null
            const ok = doneSuccess ?? (code === 0 && failed === 0 && passed > 0)
            // Don't let baro's startup "User goal:" banner (it echoes the goal to stderr)
            // or the agent CLI's harmless "no stdin" warning masquerade as the failure
            // reason — filter them + the goal lines out so the helpful fallback can win.
            const goalLines = new Set(d.goal.split("\n").map((s) => s.trim()).filter(Boolean))
            const isNoise = (l: string) => /no stdin data received|redirect stdin explicitly|proceeding without it/i.test(l)
            const errTail = stderrTail
                .trim()
                .split("\n")
                .map((s) => s.trim())
                .filter((l) => l && l !== "User goal:" && !l.startsWith("User goal:") && !goalLines.has(l) && !isNoise(l))
                .slice(-3)
                .join(" · ")
                .slice(-500)
            // No usable output at all usually means the agent CLI isn't signed in on this
            // self-hosted machine — say so and point at the zero-setup path.
            const cliHint = `the agent CLI on this runner produced no output — make sure \`claude\` (or \`codex\`) is installed and signed in here (run it once), or run on baro's cloud instead (no setup)`
            resolve({
                success: ok,
                durationSecs: secs(),
                storiesPassed: passed,
                storiesTotal: stories.size || passed + failed,
                error: ok ? null : lastErr || errTail || (doneSuccess === false ? "run reported failure" : cliHint),
            })
        })
        child.on("error", (e) => resolve({ success: false, durationSecs: secs(), error: e.message }))
    })
    // diffOnly (or repo-less scratch) runs return baro's changes as a patch, not a PR.
    if ((d.diffOnly || scratch) && diffBase) {
        outcome.diff = captureDiff(cwd, diffBase)
    }
    // PR doctor (opt-in, read-only for now): once the PR is open, watch its CI and
    // report the result back so the user sees green/red in the dashboard. The auto-fix
    // loop builds on this — it's gated off until validated against real CI.
    if (process.env.BARO_PR_DOCTOR === "1" && d.repo && !d.diffOnly && !scratch && outcome.success && prUrl) {
        try {
            await watchCi(cwd, emit, signal)
        } catch (e) {
            emit({ type: "story_log", agentId: "_ci", data: { type: "story_log", id: "_ci", line: `[pr-doctor] CI watch error: ${(e as Error).message}` } })
        }
    }
    cleanup?.()
    return outcome
}

// Run a `gh` command, capturing exit code + combined output (gh exits non-zero on
// failing/pending checks, which is signal, not an error).
function gh(args: string[], cwd: string): { code: number; out: string } {
    try {
        const out = execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        return { code: 0, out }
    } catch (e) {
        const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
        return {
            code: typeof err.status === "number" ? err.status : 1,
            out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
        }
    }
}

// Poll the PR's CI until it settles, reporting status as story_log lines under "_ci"
// so it shows in the dashboard activity. Read-only — never pushes.
async function watchCi(cwd: string, emit: (e: WireEvent) => void, signal: AbortSignal): Promise<void> {
    const log = (line: string) => emit({ type: "story_log", agentId: "_ci", data: { type: "story_log", id: "_ci", line } })
    const timeoutMs = Number(process.env.BARO_PR_DOCTOR_CI_TIMEOUT ?? 900) * 1000
    const deadline = Date.now() + timeoutMs
    log("watching the pull request's CI…")
    while (Date.now() < deadline && !signal.aborted) {
        const r = gh(["pr", "checks"], cwd)
        const out = r.out.toLowerCase()
        if (out.includes("no checks") || out.includes("no commit statuses")) {
            log("no CI configured on this repo — nothing to watch.")
            return
        }
        if (r.code === 0) {
            log("✓ CI is green — all checks passed.")
            return
        }
        if (r.code === 8 || out.includes("pending") || out.includes("in progress") || out.includes("queued")) {
            await new Promise((res) => setTimeout(res, 20000))
            continue
        }
        const fails = r.out
            .split("\n")
            .filter((l) => /fail|error|✗|×/i.test(l))
            .slice(0, 8)
            .join("\n")
        log(`✗ CI is failing:\n${fails || r.out.slice(-500)}`)
        return
    }
    log("CI watch timed out while checks were still pending.")
}

// Set when the control plane refuses us (bad/expired token): stop the reconnect
// loop instead of hammering it forever with a token that will never resolve.
let rejected: string | undefined

// The live socket. An in-flight run streams through *this*, not the socket it
// started on, so events + run_result survive a reconnect: the control plane
// re-attaches by runnerId and only fails the run after a grace window.
let currentWs: WebSocket | null = null
const inflight = new Map<string, AbortController>()
// The active run's baro child — its stdin is the mid-run agent-message lane.
let activeChild: ReturnType<typeof spawn> | null = null
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
    } else if (m.t === "agent_message") {
        // Mid-run operator message → the active run's stdin command lane.
        // Dropped silently when no run is live or stdin already closed.
        const { storyId, text } = m as { storyId: string; text: string }
        const stdin = activeChild?.stdin
        if (stdin && stdin.writable && !stdin.destroyed) {
            stdin.write(`${JSON.stringify({ type: "agent_message", id: storyId, text })}\n`)
        }
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

function goodbyeAndExit(): void {
    console.log("\n[baro] runner going offline — runs will fall back to cloud. Keep it always-on: baro connect --install-service")
    process.exit(0)
}

// Casual foreground runners die with the terminal and never come back (real
// users got stranded this way) — so after the first successful pairing, offer
// once to install the login service, then hand off to it.
let serviceOffered = false
async function maybeOfferServiceInstall(): Promise<void> {
    if (serviceOffered || isService || runOnce || process.env.BARO_NO_SERVICE_PROMPT === "1") return
    serviceOffered = true
    if (!process.stdin.isTTY || !process.stdout.isTTY) return
    // Let a token rejection arrive before offering to persist that token.
    await new Promise((r) => setTimeout(r, 1500))
    if (rejected || !token || currentWs?.readyState !== WebSocket.OPEN) return
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on("SIGINT", () => {
        rl.close()
        goodbyeAndExit()
    })
    const answer = (await rl.question("\nKeep this runner online in the background (installs a login service)? [Y/n] ")).trim().toLowerCase()
    rl.close()
    if (answer === "n" || answer === "no") {
        console.log("[baro] staying in the foreground — this runner goes offline when the terminal closes.\n[baro] install the service any time: baro connect --install-service --token <rt_…>")
        return
    }
    console.log("[baro] installing the background service…")
    const args = buildInstallServiceArgs({ token, workspace: workspaceDir, controlUrl: process.env.CONTROL_URL })
    const ok = await new Promise<boolean>((resolve) => {
        const ch = spawn(baroBin, args, { stdio: "inherit", shell: process.platform === "win32" })
        ch.on("exit", (code) => resolve(code === 0))
        ch.on("error", () => resolve(false))
    })
    if (ok) {
        console.log("[baro] ✓ service installed — the runner now stays online across terminal close, logout, and reboot.")
        console.log("[baro] handing off to the service; this foreground runner is exiting.")
        currentWs?.close()
        process.exit(0)
    }
    console.warn("[baro] service install failed — staying in the foreground. Try manually: baro connect --install-service --token <rt_…>")
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
            void maybeOfferServiceInstall()
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
    // Keep runners current. We release often and a stale runner re-runs bugs we've
    // already fixed (5 field runners got stranded on 0.58–0.64 this way). Fresh check,
    // not the cache — starts are rare enough that one npm hit is fine. BARO_UPDATED
    // marks the post-update re-exec: skip the check so a bad publish that still
    // reports an old version can't loop update→restart forever.
    if (process.env.BARO_UPDATED !== "1") {
        try {
            const latest = await getLatest(true)
            if (latest && semverLt(VERSION, latest)) {
                if (await selfUpdate(latest)) {
                    if (isService) {
                        console.log(`[baro] updated to ${latest} — restarting service…`)
                        process.exit(0) // launchd/systemd/Task Scheduler relaunches with the new version
                    }
                    console.log(`[baro] updated to ${latest} — restarting the runner…`)
                    reexecUpdated()
                    return // the child owns the terminal now; this process exits when it does
                }
                console.warn(`[baro] could not self-update (likely a root-owned global install). Update manually: npm i -g baro-ai@latest`)
            }
        } catch {
            /* never let the update check block the runner */
        }
    }
    // A service stays up for weeks; recheck every 6h and restart into updates
    // (launchd/systemd/schtasks relaunch it) — but never yank a machine mid-run.
    if (isService) {
        setInterval(() => {
            void (async () => {
                try {
                    const latest = await getLatest(true)
                    if (latest && semverLt(VERSION, latest) && inflight.size === 0 && (await selfUpdate(latest))) {
                        console.log(`[baro] updated to ${latest} — restarting service…`)
                        process.exit(0)
                    }
                } catch {
                    /* retry next tick */
                }
            })()
        }, 6 * 3600_000).unref()
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
    // Casual foreground exit (Ctrl+C, terminal close) silently strands the org
    // with no runner — say what that means and how to avoid it next time.
    if (!isService && !runOnce) {
        process.on("SIGINT", goodbyeAndExit)
        process.on("SIGTERM", goodbyeAndExit)
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
