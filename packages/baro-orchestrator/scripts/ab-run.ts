#!/usr/bin/env node
/**
 * Local, paired A/B runner for Baro's legacy and collective coordination modes.
 *
 * The target repository is never used as an execution cwd. Every trial gets a
 * no-hardlink local clone with all remotes removed, the exact same base commit,
 * and the exact same frozen PRD bytes. Baro itself is invoked from this source
 * checkout; nothing is installed or released.
 */

import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { homedir, platform } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { createReadStream } from "node:fs"
import {
    meanComplete,
    metricCoverageLabel,
    runtimeReplanAuditKey,
    summarizeReplanEvents,
    totalCompleteMetrics,
    type CompleteMetricTotal,
} from "../src/benchmark-metrics.js"
import {
    knownMetric,
    notApplicableMetric,
    reduceModelTelemetry,
    unknownMetric,
    type Metric,
    type ModelInvocationMeasuredData,
} from "../src/model-telemetry.js"
import {
    freezeVerificationInputs,
    includeUnmeasuredAttempts,
    StoryAttemptCoverageTracker,
    verificationInputsFingerprint,
    verificationInputsMatch,
    type FrozenVerificationInput,
} from "./ab-evidence.js"

type Arm = "legacy" | "collective"

interface Options {
    repo?: string
    prd?: string
    base: string
    out?: string
    caseName?: string
    runs: number
    setup: string[]
    verify: string[]
    verifyInput: string[]
    orchestratorArgs: string[]
    runTimeoutSecs: number
    commandTimeoutSecs: number
    dryRun: boolean
    help: boolean
}

interface CapturedCommand {
    command: string
    exitCode: number | null
    signal: NodeJS.Signals | null
    durationMs: number
    timedOut: boolean
    spawnError?: string
    stdoutPath: string
    stderrPath: string
    stdoutTail: string
    stderrTail: string
}

interface EventMetrics {
    lines: number
    parseErrors: number
    counts: Record<string, number>
    inputTokens: CompleteMetricTotal
    outputTokens: CompleteMetricTotal
    costUsd: CompleteMetricTotal
    storyModelInvocations: number
    unmeasuredStoryAttempts: number
    done: Record<string, unknown> | null
}

interface AuditMetrics {
    lines: number
    parseErrors: number
    counts: Record<string, number>
    runCompleted: Record<string, unknown> | null
    totalAttempts: number | null
    storyAttemptsStarted: number
    storyAttemptsReported: number
    storyAttemptsWithModelMeasurement: number
    unmeasuredStoryAttempts: number
    observedStoryAttempts: number | null
    runtimeReplans: {
        proposedUnique: number
        appliedCommits: number
        appliedDeliveries: number
        rejectedUnique: number
    }
}

interface DiffMetrics {
    headSha: string
    commits: number
    filesChanged: number
    additions: number
    deletions: number
    binaryFiles: number
    diffSha256: string
    statusBeforeVerify: string
}

interface TrialResult {
    arm: Arm
    repetition: number
    directory: string
    clone: string
    baseSha: string
    prdSha256: string
    orchestrator: CapturedCommand
    events: EventMetrics
    audit: AuditMetrics
    diff: DiffMetrics
    verification: CapturedCommand[]
    verificationPassed: boolean
    statusAfterVerify: string
    selfReportedSuccess: boolean
}

class UsageError extends Error {}

const SCRIPT_DIR = import.meta.dirname
const BARO_ROOT = resolve(SCRIPT_DIR, "../../..")
const ORCHESTRATOR_ROOT = resolve(SCRIPT_DIR, "..")
const CLI_PATH = join(SCRIPT_DIR, "cli.ts")
const TSX_CLI = join(BARO_ROOT, "node_modules", "tsx", "dist", "cli.mjs")
const ARMS: readonly Arm[] = ["legacy", "collective"]
const MAX_LOG_TAIL_BYTES = 6_000
const TRIAL_PRD_NAME = ".baro-experiment-prd.json"

function helpText(): string {
    return `baro collective A/B experiment (local only)

Usage:
  node --import tsx packages/baro-orchestrator/scripts/ab-run.ts \\
    --repo /path/to/target-repo --prd /path/to/frozen-prd.json \\
    --verify "npm test" [options]

Required:
  --repo <path>                 Clean target git repository (read-only source)
  --prd <path>                  Frozen PRD copied byte-for-byte into every trial
  --verify <command>            External verification command; repeatable

Options:
  --base <ref>                  Target base ref (default: HEAD)
  --out <path>                  New results directory (default: ~/.baro/experiments/...)
  --case-name <name>            Label used in the default output directory
  --runs <N>                    Paired repetitions (default: 1; use >=3 for evidence)
  --setup <command>             Per-clone setup command; repeatable
  --verify-input <file>         External verifier/fixture to hash; repeatable
                                Literal absolute files in --verify are auto-detected
  --orchestrator-arg <value>    Shared cli.ts argument; repeat for flags and values
                                Example: --orchestrator-arg=--llm --orchestrator-arg=codex
  --run-timeout-secs <N>        Whole orchestrator timeout (default: 14400)
  --command-timeout-secs <N>    Timeout for each setup/verify command (default: 1800)
  --dry-run                     Validate and print the experiment plan; write nothing
  -h, --help                    Show this help

The harness always adds --coordination <legacy|collective>, --local-only,
--cwd, --prd, and --audit-log. Those flags are forbidden in --orchestrator-arg.
Both arms run sequentially in independent no-hardlink clones with no remotes.
`
}

function parseArgs(argv: string[]): Options {
    const out: Options = {
        base: "HEAD",
        runs: 1,
        setup: [],
        verify: [],
        verifyInput: [],
        orchestratorArgs: [],
        runTimeoutSecs: 4 * 60 * 60,
        commandTimeoutSecs: 30 * 60,
        dryRun: false,
        help: false,
    }

    const valueFor = (flag: string, inline: string | undefined, index: number): [string, number] => {
        if (inline !== undefined) return [inline, index]
        const value = argv[index + 1]
        if (value === undefined) throw new UsageError(`${flag} requires a value`)
        return [value, index + 1]
    }

    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i]
        const eq = raw.startsWith("--") ? raw.indexOf("=") : -1
        const flag = eq >= 0 ? raw.slice(0, eq) : raw
        const inline = eq >= 0 ? raw.slice(eq + 1) : undefined
        let value: string

        switch (flag) {
            case "-h":
            case "--help":
                out.help = true
                break
            case "--dry-run":
                out.dryRun = true
                break
            case "--repo":
                ;[value, i] = valueFor(flag, inline, i)
                out.repo = value
                break
            case "--prd":
                ;[value, i] = valueFor(flag, inline, i)
                out.prd = value
                break
            case "--base":
                ;[value, i] = valueFor(flag, inline, i)
                out.base = value
                break
            case "--out":
                ;[value, i] = valueFor(flag, inline, i)
                out.out = value
                break
            case "--case-name":
                ;[value, i] = valueFor(flag, inline, i)
                out.caseName = value
                break
            case "--runs":
                ;[value, i] = valueFor(flag, inline, i)
                out.runs = positiveInt(value, flag, 20)
                break
            case "--setup":
                ;[value, i] = valueFor(flag, inline, i)
                out.setup.push(value)
                break
            case "--verify":
                ;[value, i] = valueFor(flag, inline, i)
                out.verify.push(value)
                break
            case "--verify-input":
                ;[value, i] = valueFor(flag, inline, i)
                out.verifyInput.push(value)
                break
            case "--orchestrator-arg":
                ;[value, i] = valueFor(flag, inline, i)
                out.orchestratorArgs.push(value)
                break
            case "--run-timeout-secs":
                ;[value, i] = valueFor(flag, inline, i)
                out.runTimeoutSecs = positiveInt(value, flag)
                break
            case "--command-timeout-secs":
                ;[value, i] = valueFor(flag, inline, i)
                out.commandTimeoutSecs = positiveInt(value, flag)
                break
            default:
                throw new UsageError(`unknown flag: ${raw}`)
        }
    }
    return out
}

function positiveInt(raw: string, flag: string, max = Number.MAX_SAFE_INTEGER): number {
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new UsageError(`${flag} must be an integer between 1 and ${max}`)
    }
    return value
}

function gitRaw(cwd: string, args: string[]): string {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 64 * 1024 * 1024,
        })
    } catch (error) {
        const e = error as { stderr?: string | Buffer; message?: string }
        const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8")
        throw new Error(`git ${args.join(" ")} failed: ${(stderr || e.message || "unknown error").trim()}`)
    }
}

function git(cwd: string, args: string[]): string {
    return gitRaw(cwd, args).trim()
}

function gitGlobal(args: string[]): string {
    return git(BARO_ROOT, args)
}

function sha256(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex")
}

function isWithin(parent: string, child: string): boolean {
    const rel = relative(parent, child)
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))
}

function canonicalProspectivePath(path: string): string {
    let cursor = resolve(path)
    const missing: string[] = []
    while (!existsSync(cursor)) {
        const parent = dirname(cursor)
        if (parent === cursor) break
        missing.unshift(basename(cursor))
        cursor = parent
    }
    return resolve(realpathSync(cursor), ...missing)
}

function slug(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "experiment"
}

function shellQuote(raw: string): string {
    return `'${raw.replace(/'/g, `'\\''`)}'`
}

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-")
}

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
}

function tail(path: string): string {
    if (!existsSync(path)) return ""
    const data = readFileSync(path)
    return data.subarray(Math.max(0, data.length - MAX_LOG_TAIL_BYTES)).toString("utf8")
}

function cleanChildEnv(cwd: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", PWD: cwd }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE
    delete env.OLDPWD
    return env
}

async function runCaptured(options: {
    command: string
    args: string[]
    cwd: string
    stdoutPath: string
    stderrPath: string
    timeoutSecs: number
    display: string
}): Promise<CapturedCommand> {
    const stdoutFd = openSync(options.stdoutPath, "w")
    const stderrFd = openSync(options.stderrPath, "w")
    const started = Date.now()
    let timedOut = false
    let spawnError: string | undefined

    try {
        const detached = process.platform !== "win32"
        const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: cleanChildEnv(options.cwd),
            stdio: ["ignore", stdoutFd, stderrFd],
            detached,
        })
        child.on("error", (error) => {
            spawnError = error.message
        })

        const killTree = (signal: NodeJS.Signals): void => {
            if (!child.pid) return
            if (process.platform === "win32") {
                try {
                    execFileSync(
                        "taskkill",
                        ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])],
                        { stdio: "ignore" },
                    )
                    return
                } catch {}
            } else {
                try {
                    process.kill(-child.pid, signal)
                    return
                } catch {}
            }
            child.kill(signal)
        }
        let forceKill: ReturnType<typeof setTimeout> | null = null
        const timeout = setTimeout(() => {
            timedOut = true
            killTree("SIGTERM")
            forceKill = setTimeout(() => killTree("SIGKILL"), 5_000)
            forceKill.unref()
        }, options.timeoutSecs * 1_000)
        timeout.unref()

        const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
            child.once("close", (code, signal) => resolveClose({ code, signal }))
        })
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        // A shell can exit while leaving grandchildren in its process group.
        // Tear the group down after every command before another arm can start.
        killTree("SIGTERM")
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100))
        killTree("SIGKILL")

        return {
            command: options.display,
            exitCode: closed.code,
            signal: closed.signal,
            durationMs: Date.now() - started,
            timedOut,
            ...(spawnError ? { spawnError } : {}),
            stdoutPath: options.stdoutPath,
            stderrPath: options.stderrPath,
            stdoutTail: "",
            stderrTail: "",
        }
    } finally {
        closeSync(stdoutFd)
        closeSync(stderrFd)
    }
}

async function runShell(command: string, cwd: string, prefix: string, timeoutSecs: number): Promise<CapturedCommand> {
    const stdoutPath = `${prefix}.stdout.log`
    const stderrPath = `${prefix}.stderr.log`
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh"
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]
    const result = await runCaptured({
        command: shell,
        args,
        cwd,
        stdoutPath,
        stderrPath,
        timeoutSecs,
        display: command,
    })
    result.stdoutTail = tail(stdoutPath)
    result.stderrTail = tail(stderrPath)
    return result
}

async function countJsonl(path: string, audit: boolean): Promise<EventMetrics | AuditMetrics> {
    const counts: Record<string, number> = {}
    let lines = 0
    let parseErrors = 0
    const legacyInput: Metric[] = []
    const legacyOutput: Metric[] = []
    const legacyCost: Metric[] = []
    const modelMeasurements: ModelInvocationMeasuredData[] = []
    let done: Record<string, unknown> | null = null
    let runCompleted: Record<string, unknown> | null = null
    let totalAttempts: number | null = null
    let storyAttemptsStarted = 0
    let storyAttemptsReported = 0
    const attemptCoverage = new StoryAttemptCoverageTracker()
    const runtimeReplanKeys = {
        proposed: new Set<string>(),
        applied: new Set<string>(),
        rejected: new Set<string>(),
    }

    if (existsSync(path)) {
        const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
        for await (const line of rl) {
            if (!line.trim()) continue
            lines++
            try {
                const parsed = JSON.parse(line) as Record<string, unknown>
                const rawItem = audit ? parsed.item : parsed
                if (!rawItem || typeof rawItem !== "object") continue
                const item = rawItem as Record<string, unknown>
                const type = typeof item.type === "string" ? item.type : "(unknown)"
                counts[type] = (counts[type] ?? 0) + 1
                const payload = item.data && typeof item.data === "object"
                    ? item.data as Record<string, unknown>
                    : item
                const source = typeof parsed.source === "string" ? parsed.source : ""
                if (audit && type.startsWith("runtime_replan_")) {
                    const key = runtimeReplanAuditKey(type, payload)
                    if (key) {
                        if (type === "runtime_replan_proposed") {
                            runtimeReplanKeys.proposed.add(key)
                        } else if (type === "runtime_replan_applied") {
                            runtimeReplanKeys.applied.add(key)
                        } else if (type === "runtime_replan_rejected") {
                            runtimeReplanKeys.rejected.add(key)
                        }
                    }
                }

                if (!audit && type === "token_usage") {
                    legacyInput.push(metricFromNumber(payload.input_tokens))
                    legacyOutput.push(metricFromNumber(payload.output_tokens))
                    legacyCost.push(metricFromNumber(payload.cost_usd))
                }
                if (!audit && type === "model_usage") {
                    const measurement = payload.measurement
                    if (!measurement || typeof measurement !== "object") continue
                    const measured = measurement as Record<string, unknown>
                    const measurementId = typeof measured.measurementId === "string"
                        ? measured.measurementId
                        : ""
                    const invocationId = typeof measured.invocationId === "string"
                        ? measured.invocationId
                        : ""
                    if (!measurementId || !invocationId) continue
                    modelMeasurements.push(measurement as ModelInvocationMeasuredData)
                }
                if (!audit && type === "done") done = payload
                if (
                    audit &&
                    type === "agent_state" &&
                    source.includes("StoryAgent:") &&
                    payload.phase === "running" &&
                    typeof payload.detail === "string" &&
                    (/^attempt \d+$/.test(payload.detail) || payload.detail === "first turn")
                ) {
                    const storyId = typeof payload.agentId === "string"
                        ? payload.agentId
                        : source.slice(source.lastIndexOf(":") + 1)
                    attemptCoverage.start(storyId)
                    storyAttemptsStarted++
                }
                if (
                    audit &&
                    type === "model_invocation_measured" &&
                    payload.phase === "story" &&
                    typeof payload.storyId === "string"
                ) {
                    attemptCoverage.measured(payload.storyId)
                }
                if (audit && type === "story_result") {
                    const attempts = payload.attempts
                    if (typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts > 0) {
                        storyAttemptsReported += attempts
                    }
                    if (typeof payload.storyId === "string") attemptCoverage.finish(payload.storyId)
                }
                if (audit && type === "run_completed") {
                    runCompleted = payload
                    totalAttempts = typeof payload.totalAttempts === "number" ? payload.totalAttempts : null
                }
            } catch {
                parseErrors++
            }
        }
    }

    if (audit) {
        attemptCoverage.finishAll()
        const observedStoryAttempts = Math.max(
            totalAttempts ?? 0,
            storyAttemptsStarted,
            storyAttemptsReported,
        ) || null
        return {
            lines,
            parseErrors,
            counts,
            runCompleted,
            totalAttempts,
            storyAttemptsStarted,
            storyAttemptsReported,
            storyAttemptsWithModelMeasurement: attemptCoverage.attemptsWithMeasurement,
            unmeasuredStoryAttempts: attemptCoverage.attemptsWithoutMeasurement,
            observedStoryAttempts,
            runtimeReplans: {
                proposedUnique: runtimeReplanKeys.proposed.size,
                appliedCommits: runtimeReplanKeys.applied.size,
                appliedDeliveries: counts.runtime_replan_applied ?? 0,
                rejectedUnique: runtimeReplanKeys.rejected.size,
            },
        }
    }
    const reduced = reduceModelTelemetry(modelMeasurements)
    const invocations = [...reduced.invocations.values()]
    const storyModelInvocations = invocations.filter((invocation) =>
        invocation.measurements.some((measurement) => measurement.phase === "story"),
    ).length
    const modelInput = invocations.map((invocation) => invocation.tokens.inputTotal)
    const modelOutput = invocations.map((invocation) => invocation.tokens.outputTotal)
    const modelCost = invocations.map((invocation) =>
        preferredCostMetric(invocation.cost as unknown as Record<string, unknown>),
    )
    const useModelTelemetry = invocations.length > 0
    return {
        lines,
        parseErrors,
        counts,
        inputTokens: totalCompleteMetrics(useModelTelemetry ? modelInput : legacyInput),
        outputTokens: totalCompleteMetrics(useModelTelemetry ? modelOutput : legacyOutput),
        costUsd: totalCompleteMetrics(useModelTelemetry ? modelCost : legacyCost),
        storyModelInvocations,
        unmeasuredStoryAttempts: 0,
        done,
    }
}

function accountForUnmeasuredStoryAttempts(
    events: EventMetrics,
    audit: AuditMetrics,
): EventMetrics {
    // Every started story attempt invokes its story backend at least once. A
    // killed process may never emit the terminal usage frame that normally
    // creates model_usage, so use the durable lifecycle audit as a lower-bound
    // denominator instead of letting measured-only coverage look complete.
    const unmeasuredStoryAttempts = Math.max(
        audit.unmeasuredStoryAttempts,
        0,
        (audit.observedStoryAttempts ?? 0) - events.storyModelInvocations,
    )
    return {
        ...events,
        inputTokens: includeUnmeasuredAttempts(events.inputTokens, unmeasuredStoryAttempts),
        outputTokens: includeUnmeasuredAttempts(events.outputTokens, unmeasuredStoryAttempts),
        costUsd: includeUnmeasuredAttempts(events.costUsd, unmeasuredStoryAttempts),
        unmeasuredStoryAttempts,
    }
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function metricFromNumber(value: unknown): Metric {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? knownMetric(value, "cli_result")
        : unknownMetric("not_reported")
}

function metricFromWire(value: unknown): Metric {
    const metric = recordOf(value)
    if (metric.state === "known") {
        return typeof metric.value === "number" && Number.isFinite(metric.value) && metric.value >= 0
            ? knownMetric(metric.value, "cli_result")
            : unknownMetric("parse_error")
    }
    if (metric.state === "not_applicable") return notApplicableMetric()
    if (metric.state === "unknown") return unknownMetric("not_reported")
    return unknownMetric("parse_error")
}

function preferredCostMetric(cost: Record<string, unknown>): Metric {
    const customer = metricFromWire(cost.customerUsd)
    if (customer.state === "known") return customer
    const provider = metricFromWire(cost.providerUsd)
    if (provider.state === "known") return provider
    const equivalent = metricFromWire(cost.equivalentUsd)
    if (equivalent.state === "known") return equivalent
    if (customer.state === "unknown") return customer
    if (provider.state === "unknown") return provider
    if (equivalent.state === "unknown") return equivalent
    return notApplicableMetric()
}

function collectDiff(clone: string, baseSha: string, trialDir: string): DiffMetrics {
    // Include untracked, non-ignored agent output in the diff without committing it.
    try {
        git(clone, ["add", "-N", "--", "."])
    } catch {
        // A successful story normally commits everything; keep collecting even
        // if an unusual untracked path cannot be marked intent-to-add.
    }

    const patch = gitRaw(clone, ["diff", "--binary", baseSha])
    const patchPath = join(trialDir, "diff.patch")
    writeFileSync(patchPath, patch)

    const numstat = git(clone, ["diff", "--numstat", baseSha])
    let additions = 0
    let deletions = 0
    let binaryFiles = 0
    let filesChanged = 0
    for (const line of numstat.split("\n")) {
        if (!line) continue
        const [added, removed] = line.split("\t")
        filesChanged++
        if (added === "-" || removed === "-") {
            binaryFiles++
        } else {
            additions += Number(added) || 0
            deletions += Number(removed) || 0
        }
    }

    return {
        headSha: git(clone, ["rev-parse", "HEAD"]),
        commits: Number(git(clone, ["rev-list", "--count", `${baseSha}..HEAD`])) || 0,
        filesChanged,
        additions,
        deletions,
        binaryFiles,
        diffSha256: sha256(patch),
        statusBeforeVerify: git(clone, ["status", "--porcelain=v1", "--untracked-files=all"]),
    }
}

function redactArgs(args: string[]): string[] {
    const redacted: string[] = []
    let hideNext = false
    for (const arg of args) {
        if (hideNext) {
            redacted.push("[REDACTED]")
            hideNext = false
            continue
        }
        if (/^--[^=]*(?:key|token|password|secret)$/i.test(arg)) {
            redacted.push(arg)
            hideNext = true
        } else if (/^--[^=]*(?:key|token|password|secret)=/i.test(arg)) {
            redacted.push(arg.replace(/=.*/, "=[REDACTED]"))
        } else {
            redacted.push(arg)
        }
    }
    return redacted
}

function runtimeFingerprint(): string {
    const files: string[] = []
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name)
            if (entry.isDirectory()) walk(path)
            else if (
                entry.isFile() &&
                (
                    entry.name.endsWith(".ts") ||
                    entry.name.endsWith(".js") ||
                    entry.name.endsWith(".mjs")
                )
            ) files.push(path)
        }
    }
    walk(join(ORCHESTRATOR_ROOT, "src"))
    walk(join(BARO_ROOT, "packages", "baro-memory", "src"))
    const memoryDist = join(BARO_ROOT, "packages", "baro-memory", "dist")
    if (existsSync(memoryDist)) walk(memoryDist)
    files.push(
        CLI_PATH,
        join(SCRIPT_DIR, "ab-run.ts"),
        join(SCRIPT_DIR, "ab-evidence.ts"),
        join(SCRIPT_DIR, "agent-collab.mjs"),
        join(BARO_ROOT, "package-lock.json"),
        join(ORCHESTRATOR_ROOT, "package.json"),
        join(BARO_ROOT, "packages", "baro-memory", "package.json"),
    )
    files.sort()
    const hash = createHash("sha256")
    for (const file of files) {
        hash.update(relative(BARO_ROOT, file)).update("\0").update(readFileSync(file)).update("\0")
    }
    return hash.digest("hex")
}

interface RepositorySnapshot {
    head: string
    refsSha256: string
    configSha256: string
    status: string
}

function repositorySnapshot(cwd: string): RepositorySnapshot {
    return {
        head: git(cwd, ["rev-parse", "HEAD"]),
        refsSha256: sha256(gitRaw(cwd, ["show-ref"])),
        configSha256: sha256(gitRaw(cwd, ["config", "--local", "--list"])),
        status: git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    }
}

function removeLocalHeads(cwd: string): void {
    const heads = git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads"])
        .split("\n")
        .filter(Boolean)
    for (const head of heads) git(cwd, ["update-ref", "-d", head])
}

function hardenClone(clone: string, emptyHooks: string, id: string): void {
    for (const remote of git(clone, ["remote"]).split("\n").filter(Boolean)) {
        git(clone, ["remote", "remove", remote])
    }
    git(clone, [
        "submodule", "foreach", "--quiet", "--recursive",
        'for r in $(git remote); do git remote remove "$r"; done',
    ])
    if (git(clone, ["remote"]) !== "") throw new Error(`${id}: clone still has a git remote`)

    const alternates = join(clone, ".git", "objects", "info", "alternates")
    if (existsSync(alternates)) throw new Error(`${id}: clone unexpectedly shares objects via alternates`)
    git(clone, [
        "submodule", "foreach", "--quiet", "--recursive",
        'test -z "$(git remote)" && test ! -f "$(git rev-parse --git-path objects/info/alternates)"',
    ])

    git(clone, ["config", "core.hooksPath", emptyHooks])
    git(clone, ["config", "commit.gpgsign", "false"])
    git(clone, ["config", "tag.gpgsign", "false"])
    git(clone, ["config", "user.name", "Baro Local Experiment"])
    git(clone, ["config", "user.email", "baro-experiment@local.invalid"])
    const hooksArg = shellQuote(emptyHooks)
    git(clone, [
        "submodule", "foreach", "--quiet", "--recursive",
        `git config core.hooksPath ${hooksArg} && git config commit.gpgsign false && git config tag.gpgsign false`,
    ])
    if (git(clone, ["config", "--get", "core.hooksPath"]) !== emptyHooks) {
        throw new Error(`${id}: failed to enforce empty git hooks`)
    }
}

async function runTrial(context: {
    source: string
    baseSha: string
    prdBytes: Buffer
    prdSha256: string
    outDir: string
    runtimeFingerprint: string
    verificationInputs: readonly FrozenVerificationInput[]
    verificationInputsFingerprint: string
    options: Options
}, repetition: number, arm: Arm): Promise<TrialResult> {
    const id = `${String(repetition).padStart(2, "0")}-${arm}`
    const trialDir = join(context.outDir, "runs", id)
    const clone = join(trialDir, "repo")
    mkdirSync(trialDir, { recursive: true })
    if (runtimeFingerprint() !== context.runtimeFingerprint) {
        throw new Error(`${id}: Baro runtime changed before this arm`)
    }
    if (!verificationInputsMatch(context.verificationInputs)) {
        throw new Error(`${id}: a frozen external verification input changed before this arm`)
    }

    process.stderr.write(`[ab] ${id}: cloning immutable base ${context.baseSha.slice(0, 12)}\n`)
    gitGlobal(["clone", "--local", "--no-hardlinks", "--no-checkout", context.source, clone])
    git(clone, ["checkout", "--detach", context.baseSha])
    removeLocalHeads(clone)

    const emptyHooks = join(trialDir, "empty-hooks")
    mkdirSync(emptyHooks)
    hardenClone(clone, emptyHooks, id)
    // Do not rely on the orchestrator reaching its own exclude step: even an
    // early CLI/config failure must not make the frozen PRD appear in the code diff.
    const excludePath = git(clone, ["rev-parse", "--git-path", "info/exclude"])
    appendFileSync(resolve(clone, excludePath), `\n# Baro local A/B input\n${TRIAL_PRD_NAME}\n`)

    const setupResults: CapturedCommand[] = []
    for (let i = 0; i < context.options.setup.length; i++) {
        const command = context.options.setup[i]
        process.stderr.write(`[ab] ${id}: setup ${i + 1}/${context.options.setup.length}: ${command}\n`)
        const result = await runShell(
            command,
            clone,
            join(trialDir, `setup-${String(i + 1).padStart(2, "0")}`),
            context.options.commandTimeoutSecs,
        )
        setupResults.push(result)
        if (result.exitCode !== 0 || result.timedOut) {
            writeJson(join(trialDir, "setup.json"), setupResults)
            throw new Error(`${id}: setup failed: ${command}\n${result.stderrTail}`)
        }
    }
    writeJson(join(trialDir, "setup.json"), setupResults)

    hardenClone(clone, emptyHooks, id)
    removeLocalHeads(clone)
    const setupStatus = git(clone, ["status", "--porcelain=v1", "--untracked-files=all"])
    if (setupStatus !== "") {
        throw new Error(`${id}: setup changed the A/B baseline:\n${setupStatus}`)
    }
    if (git(clone, ["rev-parse", "HEAD"]) !== context.baseSha) {
        throw new Error(`${id}: setup moved HEAD away from the frozen base`)
    }

    const trialPrd = join(clone, TRIAL_PRD_NAME)
    writeFileSync(trialPrd, context.prdBytes)
    if (sha256(readFileSync(trialPrd)) !== context.prdSha256) {
        throw new Error(`${id}: copied PRD hash does not match the frozen input`)
    }

    const stdoutPath = join(trialDir, "events.jsonl")
    const stderrPath = join(trialDir, "stderr.log")
    const auditPath = join(trialDir, "audit.jsonl")
    const cliArgs = [
        TSX_CLI,
        CLI_PATH,
        "--prd", TRIAL_PRD_NAME,
        "--cwd", clone,
        "--coordination", arm,
        "--local-only",
        "--audit-log", auditPath,
        ...context.options.orchestratorArgs,
    ]
    writeJson(join(trialDir, "trial-manifest.json"), {
        arm,
        repetition,
        sourceBaseSha: context.baseSha,
        prdSha256: context.prdSha256,
        command: [process.execPath, ...redactArgs(cliArgs)],
        setup: context.options.setup,
        verify: context.options.verify,
        verificationInputs: context.verificationInputs,
        verificationInputsFingerprint: context.verificationInputsFingerprint,
    })

    process.stderr.write(`[ab] ${id}: running coordination=${arm}\n`)
    const orchestrator = await runCaptured({
        command: process.execPath,
        args: cliArgs,
        cwd: clone,
        stdoutPath,
        stderrPath,
        timeoutSecs: context.options.runTimeoutSecs,
        display: [process.execPath, ...redactArgs(cliArgs)].join(" "),
    })
    orchestrator.stdoutTail = tail(stdoutPath)
    orchestrator.stderrTail = tail(stderrPath)

    const rawEvents = await countJsonl(stdoutPath, false) as EventMetrics
    const audit = await countJsonl(auditPath, true) as AuditMetrics
    const events = accountForUnmeasuredStoryAttempts(rawEvents, audit)
    const diff = collectDiff(clone, context.baseSha, trialDir)

    const verification: CapturedCommand[] = []
    for (let i = 0; i < context.options.verify.length; i++) {
        const command = context.options.verify[i]
        process.stderr.write(`[ab] ${id}: verify ${i + 1}/${context.options.verify.length}: ${command}\n`)
        verification.push(await runShell(
            command,
            clone,
            join(trialDir, `verify-${String(i + 1).padStart(2, "0")}`),
            context.options.commandTimeoutSecs,
        ))
    }
    const verificationPassed = verification.every((result) => result.exitCode === 0 && !result.timedOut)
    if (!verificationInputsMatch(context.verificationInputs)) {
        throw new Error(`${id}: a frozen external verification input changed during this arm`)
    }
    const statusAfterVerify = git(clone, ["status", "--porcelain=v1", "--untracked-files=all"])
    const doneSuccess = events.done?.success
    const auditSuccess = audit.runCompleted?.success
    const selfReportedSuccess = orchestrator.exitCode === 0 &&
        (doneSuccess === true || (doneSuccess === undefined && auditSuccess === true))

    const result: TrialResult = {
        arm,
        repetition,
        directory: trialDir,
        clone,
        baseSha: context.baseSha,
        prdSha256: context.prdSha256,
        orchestrator,
        events,
        audit,
        diff,
        verification,
        verificationPassed,
        statusAfterVerify,
        selfReportedSuccess,
    }
    writeJson(join(trialDir, "metrics.json"), result)
    if (runtimeFingerprint() !== context.runtimeFingerprint) {
        throw new Error(`${id}: Baro runtime changed during this arm`)
    }
    process.stderr.write(
        `[ab] ${id}: orchestrator=${orchestrator.exitCode === 0 ? "ok" : "failed"}, ` +
        `verify=${verificationPassed ? "ok" : "failed"}, ${Math.round(orchestrator.durationMs / 1000)}s\n`,
    )
    return result
}

function mean(values: number[]): number {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: number[]): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function sumCount(trials: TrialResult[], type: string, fromAudit = true): number {
    return trials.reduce((sum, trial) => sum + ((fromAudit ? trial.audit.counts : trial.events.counts)[type] ?? 0), 0)
}

function summarize(trials: TrialResult[]): Record<string, unknown> {
    // Use the durable semantic-event stream only. Runtime Applied is also
    // forwarded to stdout as a TUI `replan`, but counting that projection
    // would double-count one committed graph mutation.
    const replanEvents = summarizeReplanEvents({
        replan: sumCount(trials, "replan"),
        runtime_replan_proposed: trials.reduce(
            (sum, trial) => sum + trial.audit.runtimeReplans.proposedUnique,
            0,
        ),
        runtime_replan_applied: trials.reduce(
            (sum, trial) => sum + trial.audit.runtimeReplans.appliedCommits,
            0,
        ),
        runtime_replan_rejected: trials.reduce(
            (sum, trial) => sum + trial.audit.runtimeReplans.rejectedUnique,
            0,
        ),
    })
    const arm = trials[0]?.arm
    return {
        trials: trials.length,
        selfReportedSuccesses: trials.filter((trial) => trial.selfReportedSuccess).length,
        verificationSuccesses: trials.filter((trial) => trial.verificationPassed).length,
        medianWallTimeSecs: median(trials.map((trial) => trial.orchestrator.durationMs / 1000)),
        meanWallTimeSecs: mean(trials.map((trial) => trial.orchestrator.durationMs / 1000)),
        meanInputTokens: meanComplete(trials.map((trial) => trial.events.inputTokens.value)),
        inputTokenCoverage: combinedCoverage(trials.map((trial) => trial.events.inputTokens)),
        meanOutputTokens: meanComplete(trials.map((trial) => trial.events.outputTokens.value)),
        outputTokenCoverage: combinedCoverage(trials.map((trial) => trial.events.outputTokens)),
        meanCostUsd: meanComplete(trials.map((trial) => trial.events.costUsd.value)),
        costCoverage: combinedCoverage(trials.map((trial) => trial.events.costUsd)),
        meanAttempts: meanComplete(trials.map((trial) => trial.audit.observedStoryAttempts)),
        unmeasuredStoryAttempts: trials.reduce(
            (sum, trial) => sum + trial.events.unmeasuredStoryAttempts,
            0,
        ),
        meanFilesChanged: mean(trials.map((trial) => trial.diff.filesChanged)),
        meanLinesChanged: mean(trials.map((trial) => trial.diff.additions + trial.diff.deletions)),
        mergeFailures: sumCount(trials, "story_merge_failed"),
        replans:
            arm === "collective"
                ? replanEvents.runtimeApplied
                : replanEvents.legacyEvents,
        legacyReplanEvents: replanEvents.legacyEvents,
        runtimeReplanProposed: replanEvents.runtimeProposed,
        runtimeReplanApplied: replanEvents.runtimeApplied,
        runtimeReplanAppliedDeliveries: trials.reduce(
            (sum, trial) =>
                sum + trial.audit.runtimeReplans.appliedDeliveries,
            0,
        ),
        runtimeReplanRejected: replanEvents.runtimeRejected,
        recoveries: sumCount(trials, "recovery_started"),
        critiques: sumCount(trials, "critique"),
        targetedMessages: sumCount(trials, "agent_targeted_message"),
        collaborationNotes: sumCount(trials, "collaboration_note"),
        workOffers: sumCount(trials, "work_offered"),
        workLeases: sumCount(trials, "work_lease_granted"),
        leaseExpiries: sumCount(trials, "work_lease_expired"),
        peerHelpRequests: sumCount(trials, "peer_help_requested"),
        discoveredWork: sumCount(trials, "work_discovered"),
    }
}

function combinedCoverage(totals: readonly CompleteMetricTotal[]): string {
    return metricCoverageLabel({
        value: null,
        known: totals.reduce((sum, total) => sum + total.known, 0),
        unknown: totals.reduce((sum, total) => sum + total.unknown, 0),
        notApplicable: totals.reduce((sum, total) => sum + total.notApplicable, 0),
        total: totals.reduce((sum, total) => sum + total.total, 0),
    })
}

function markdownReport(
    summary: Record<Arm, Record<string, unknown>>,
    sourceUnchanged: boolean,
    verificationInputsUnchanged: boolean,
): string {
    const value = (arm: Arm, key: string): string => {
        const metric = summary[arm][key]
        return metric === null || metric === undefined ? "unknown" : String(metric)
    }
    const row = (label: string, key: string) => `| ${label} | ${value("legacy", key)} | ${value("collective", key)} |`
    return [
        "# Baro coordination A/B report",
        "",
        "> Compare outcome quality first. Self-reported success, event volume, or more changed lines are not proof of a better result.",
        "",
        "| Metric | legacy | collective |",
        "|---|---:|---:|",
        row("Trials", "trials"),
        row("External verification passed", "verificationSuccesses"),
        row("Self-reported success", "selfReportedSuccesses"),
        row("Median wall time (s)", "medianWallTimeSecs"),
        row("Mean input tokens", "meanInputTokens"),
        row("Input token coverage", "inputTokenCoverage"),
        row("Mean output tokens", "meanOutputTokens"),
        row("Output token coverage", "outputTokenCoverage"),
        row("Mean equivalent model cost (USD)", "meanCostUsd"),
        row("Cost coverage", "costCoverage"),
        row("Mean attempts", "meanAttempts"),
        row("Attempts without terminal usage", "unmeasuredStoryAttempts"),
        row("Mean files changed", "meanFilesChanged"),
        row("Mean lines changed", "meanLinesChanged"),
        row("Merge failures", "mergeFailures"),
        row("Committed replans", "replans"),
        row("Raw legacy/policy Replan events", "legacyReplanEvents"),
        row("Unique runtime proposals", "runtimeReplanProposed"),
        row("Unique runtime commits", "runtimeReplanApplied"),
        row("Runtime Applied deliveries (incl. replay)", "runtimeReplanAppliedDeliveries"),
        row("Unique runtime rejections", "runtimeReplanRejected"),
        row("Recoveries", "recoveries"),
        row("Critiques", "critiques"),
        row("Targeted messages", "targetedMessages"),
        row("Collaboration notes", "collaborationNotes"),
        row("Work offers", "workOffers"),
        row("Work leases", "workLeases"),
        row("Lease expiries", "leaseExpiries"),
        row("Peer help requests", "peerHelpRequests"),
        row("Discovered work", "discoveredWork"),
        "",
        `Source repository unchanged: **${sourceUnchanged ? "yes" : "NO — investigate before trusting this run"}**`,
        `External verification inputs unchanged: **${verificationInputsUnchanged ? "yes" : "NO — verifier evidence drifted"}**`,
        "Equivalent model cost is the CLI's rate-card estimate, not the marginal charge for a subscription-backed run.",
        "",
        "Inspect each `runs/<repeat>-<arm>/diff.patch`, `metrics.json`, verifier logs, and retained clone. For a real decision, use at least three paired repetitions and review anonymized diffs without knowing which arm produced them.",
        "",
    ].join("\n")
}

function validateOrchestratorArgs(args: string[]): void {
    const owned = [
        "--coordination",
        "--local-only",
        "--cwd",
        "--prd",
        "--audit-log",
        "--no-tui-events",
        "--continue",
        "--help",
        "-h",
    ]
    for (const arg of args) {
        if (owned.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
            throw new UsageError(`${arg} is owned by the harness and cannot be supplied via --orchestrator-arg`)
        }
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        process.stdout.write(helpText())
        return
    }
    if (!options.repo) throw new UsageError("--repo is required")
    if (!options.prd) throw new UsageError("--prd is required")
    if (options.verify.length === 0) throw new UsageError("at least one --verify command is required")
    validateOrchestratorArgs(options.orchestratorArgs)
    if (!existsSync(CLI_PATH)) throw new Error(`orchestrator CLI not found: ${CLI_PATH}`)
    if (!existsSync(TSX_CLI)) throw new Error(`tsx not found: ${TSX_CLI}; run npm install in ${BARO_ROOT}`)

    const requestedRepo = realpathSync(resolve(options.repo))
    if (!statSync(requestedRepo).isDirectory()) throw new UsageError(`--repo is not a directory: ${requestedRepo}`)
    const source = realpathSync(git(requestedRepo, ["rev-parse", "--show-toplevel"]))
    const sourceBefore = repositorySnapshot(source)
    if (sourceBefore.status !== "") {
        throw new UsageError(`source repo must be clean; uncommitted files are not part of a frozen base:\n${sourceBefore.status}`)
    }
    const baseSha = git(source, ["rev-parse", `${options.base}^{commit}`])
    if (git(source, ["ls-tree", "-r", "--name-only", baseSha, "--", TRIAL_PRD_NAME]) !== "") {
        throw new UsageError(`target base already tracks reserved experiment path ${TRIAL_PRD_NAME}`)
    }

    const prdPath = realpathSync(resolve(options.prd))
    if (!statSync(prdPath).isFile()) throw new UsageError(`--prd is not a file: ${prdPath}`)
    const prdBytes = readFileSync(prdPath)
    let prd: Record<string, unknown>
    try {
        prd = JSON.parse(prdBytes.toString("utf8")) as Record<string, unknown>
    } catch (error) {
        throw new UsageError(`PRD is not valid JSON: ${(error as Error).message}`)
    }
    const stories = prd.userStories
    if (!Array.isArray(stories) || stories.length === 0) {
        throw new UsageError("PRD must contain at least one userStories entry")
    }
    if (stories.some((story) => story && typeof story === "object" && (story as Record<string, unknown>).passes === true)) {
        throw new UsageError("frozen PRD already contains passed stories; use a fresh, unexecuted plan")
    }
    const missingAcceptance = stories.filter((story) =>
        !story || typeof story !== "object" || !Array.isArray((story as Record<string, unknown>).acceptance) ||
        ((story as Record<string, unknown>).acceptance as unknown[]).length === 0,
    ).length
    if (missingAcceptance > 0) {
        process.stderr.write(`[ab] warning: ${missingAcceptance}/${stories.length} stories have no acceptance criteria\n`)
    }

    const caseName = slug(options.caseName ?? basename(source))
    const outDir = canonicalProspectivePath(
        options.out ?? join(homedir(), ".baro", "experiments", `${caseName}-${timestamp()}`),
    )
    if (isWithin(source, outDir)) throw new UsageError("--out must be outside the source repository")
    if (isWithin(realpathSync(BARO_ROOT), outDir)) {
        throw new UsageError("--out must be outside the Baro source checkout")
    }
    if (existsSync(outDir)) throw new UsageError(`--out already exists; choose a new directory: ${outDir}`)

    const prdSha256 = sha256(prdBytes)
    let verificationInputs: FrozenVerificationInput[]
    try {
        verificationInputs = freezeVerificationInputs({
            explicitPaths: options.verifyInput,
            verifyCommands: options.verify,
            launchCwd: process.cwd(),
        })
    } catch (error) {
        throw new UsageError((error as Error).message)
    }
    const verifierFingerprint = verificationInputsFingerprint(verificationInputs)
    const fingerprintBefore = runtimeFingerprint()
    const orders = Array.from({ length: options.runs }, (_, index) =>
        index % 2 === 0 ? ["legacy", "collective"] : ["collective", "legacy"],
    ) as Arm[][]
    const plan = {
        schemaVersion: 1,
        caseName,
        source,
        sourceBaseRef: options.base,
        sourceBaseSha: baseSha,
        sourceClean: true,
        prdPath,
        prdSha256,
        storyCount: stories.length,
        output: outDir,
        repetitions: options.runs,
        order: orders,
        setup: options.setup,
        verify: options.verify,
        verificationInputs,
        verificationInputsFingerprint: verifierFingerprint,
        orchestratorArgs: redactArgs(options.orchestratorArgs),
        runTimeoutSecs: options.runTimeoutSecs,
        commandTimeoutSecs: options.commandTimeoutSecs,
        baroHead: git(BARO_ROOT, ["rev-parse", "HEAD"]),
        baroRuntimeFingerprint: fingerprintBefore,
        node: process.version,
        git: gitGlobal(["--version"]),
        platform: `${platform()} ${process.arch}`,
    }

    if (options.dryRun) {
        process.stdout.write(JSON.stringify({ dryRun: true, ...plan }, null, 2) + "\n")
        if (JSON.stringify(repositorySnapshot(source)) !== JSON.stringify(sourceBefore)) {
            throw new Error("source repository changed during dry-run validation")
        }
        return
    }

    mkdirSync(join(outDir, "runs"), { recursive: true })
    writeJson(join(outDir, "manifest.json"), { startedAt: new Date().toISOString(), ...plan })

    const trials: TrialResult[] = []
    let trialFailure: string | null = null
    try {
        for (let repetition = 1; repetition <= options.runs; repetition++) {
            for (const arm of orders[repetition - 1]) {
                trials.push(await runTrial({
                    source,
                    baseSha,
                    prdBytes,
                    prdSha256,
                    outDir,
                    runtimeFingerprint: fingerprintBefore,
                    verificationInputs,
                    verificationInputsFingerprint: verifierFingerprint,
                    options,
                }, repetition, arm))
            }
        }
    } catch (error) {
        trialFailure = (error as Error)?.stack ?? String(error)
    }

    const sourceAfter = repositorySnapshot(source)
    const fingerprintAfter = runtimeFingerprint()
    const sourceUnchanged = JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore)
    const runtimeUnchanged = fingerprintAfter === fingerprintBefore
    const verificationInputsUnchanged = verificationInputsMatch(verificationInputs)
    const byArm = Object.fromEntries(ARMS.map((arm) => [arm, summarize(trials.filter((trial) => trial.arm === arm))])) as Record<Arm, Record<string, unknown>>
    const report = {
        completedAt: new Date().toISOString(),
        sourceUnchanged,
        runtimeUnchanged,
        verificationInputsUnchanged,
        sourceBefore,
        sourceAfter,
        runtimeFingerprintBefore: fingerprintBefore,
        runtimeFingerprintAfter: fingerprintAfter,
        trialFailure,
        summary: byArm,
        trials,
    }
    writeJson(join(outDir, "report.json"), report)
    writeFileSync(
        join(outDir, "report.md"),
        markdownReport(byArm, sourceUnchanged, verificationInputsUnchanged),
    )

    process.stdout.write(`${join(outDir, "report.md")}\n`)
    if (!sourceUnchanged) throw new Error("source repository changed during the experiment; results are not trustworthy")
    if (!runtimeUnchanged) throw new Error("Baro orchestrator source changed between arms; results are not comparable")
    if (!verificationInputsUnchanged) {
        throw new Error("an external verification input changed during the experiment; results are not comparable")
    }
    if (trialFailure) throw new Error(`experiment stopped before all paired trials completed:\n${trialFailure}`)
    const failedRuntimes = trials.filter((trial) =>
        trial.orchestrator.exitCode !== 0 || trial.orchestrator.timedOut,
    )
    if (failedRuntimes.length > 0) {
        throw new Error(
            `${failedRuntimes.length}/${trials.length} orchestrator runs failed or timed out; ` +
            "the artifacts were retained, but this is not a complete A/B result",
        )
    }
}

main().catch((error: unknown) => {
    const usage = error instanceof UsageError
    process.stderr.write(`[ab] ${usage ? "usage" : "fatal"}: ${(error as Error)?.message ?? String(error)}\n`)
    if (usage) process.stderr.write("Run with --help for usage.\n")
    process.exit(usage ? 2 : 1)
})
