/**
 * Standalone orchestrator CLI (run directly with tsx; the Rust TUI also
 * spawns it as a subprocess). Prints BaroEvents to stdout (one JSON per
 * line) plus a compact human summary on stderr. See --help for flags.
 */

import { existsSync, readFileSync } from "fs"
import { resolve } from "path"

import {
    orchestrate,
    validateCollectiveWorkers,
    type CollectiveWorkerCandidateConfig,
    type OrchestrateConfig,
} from "../src/orchestrate.js"
import { ClaudeCliParticipant } from "../src/participants/claude-cli-participant.js"
import { CodexCliParticipant } from "../src/participants/codex-cli-participant.js"
import { OpenCodeCliParticipant } from "../src/participants/opencode-cli-participant.js"
import { PiCliParticipant } from "../src/participants/pi-cli-participant.js"
import type { Operator } from "../src/participants/operator.js"
import { handleStdinCommand } from "../src/stdin-commands.js"
import { subscribeCommands } from "../src/tui-protocol.js"
import type { CoordinationMode } from "../src/semantic-events.js"
import {
    parseEndpoints,
    parseTierMap,
    resolveStoryRoute,
    type EndpointMap,
    type TierMap,
} from "../src/routing.js"

interface CliArgs {
    prd: string
    cwd: string
    parallel: number
    timeout: number
    coordinationMode?: CoordinationMode
    collectiveWorkersFile?: string
    collectiveBidWindowMs?: number
    collectiveMinSuccessProbability?: number
    collectiveMaxCostUsd?: number
    collectiveMaxLatencyMs?: number
    localOnly: boolean
    model?: string
    noGit: boolean
    continueRun: boolean
    noTuiEvents: boolean
    auditLog?: string
    withCritic: boolean
    criticModel?: string
    noLibrarian: boolean
    noMemory: boolean
    noSentry: boolean
    withSurgeon: boolean
    surgeonUseLlm: boolean
    withSupervisor: boolean
    withDialogue: boolean
    dialogueLlm?: "claude" | "openai"
    dialogueModel?: string
    surgeonModel?: string
    storyModel?: string
    effort?: string
    intraLevelDelaySecs?: number
    tierMap?: TierMap
    /** Raw `--openai-endpoint name=url` specs, resolved to a map later. */
    endpointSpecs: string[]
    llm: "claude" | "openai" | "codex" | "opencode" | "pi"
    /** Optional per-phase overrides; each defaults to `llm`. */
    storyLlm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    criticLlm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    surgeonLlm?: "claude" | "openai" | "codex" | "opencode" | "pi"
    help: boolean
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        prd: "prd.json",
        cwd: ".",
        parallel: 0,
        timeout: 0, // 0 = auto (effort-scaled in storyTimeoutSecs); --timeout N overrides absolutely
        localOnly: false,
        noGit: false,
        continueRun: false,
        noTuiEvents: false,
        withCritic: false,
        noLibrarian: false,
        noMemory: false,
        noSentry: false,
        // Self-healing on by default: the Supervisor catches a stuck story early
        // and the Surgeon splits/escalates it, instead of failing the whole run.
        // Disable with --no-surgeon / --no-supervisor.
        withSurgeon: true,
        surgeonUseLlm: true,
        withSupervisor: true,
        withDialogue: false,
        endpointSpecs: [],
        llm: "claude",
        help: false,
    }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case "-h":
            case "--help":
                args.help = true
                break
            case "--prd":
                args.prd = required(argv, ++i, "--prd")
                break
            case "--cwd":
                args.cwd = required(argv, ++i, "--cwd")
                break
            case "--parallel":
                args.parallel = parseInt(required(argv, ++i, "--parallel"), 10)
                break
            case "--timeout":
                args.timeout = parseInt(required(argv, ++i, "--timeout"), 10)
                break
            case "--coordination": {
                const value = required(argv, ++i, "--coordination")
                if (value !== "legacy" && value !== "collective") {
                    process.stderr.write(
                        `[cli] --coordination must be 'legacy' or 'collective', got '${value}'\n`,
                    )
                    process.exit(2)
                }
                args.coordinationMode = value
                break
            }
            case "--local-only":
                args.localOnly = true
                break
            case "--collective-workers":
                args.collectiveWorkersFile = required(argv, ++i, "--collective-workers")
                break
            case "--collective-bid-window-ms":
                args.collectiveBidWindowMs = nonNegativeNumber(
                    required(argv, ++i, "--collective-bid-window-ms"),
                    "--collective-bid-window-ms",
                )
                break
            case "--collective-min-success":
                args.collectiveMinSuccessProbability = probability(
                    required(argv, ++i, "--collective-min-success"),
                    "--collective-min-success",
                )
                break
            case "--collective-max-cost-usd":
                args.collectiveMaxCostUsd = nonNegativeNumber(
                    required(argv, ++i, "--collective-max-cost-usd"),
                    "--collective-max-cost-usd",
                )
                break
            case "--collective-max-latency-ms":
                args.collectiveMaxLatencyMs = nonNegativeNumber(
                    required(argv, ++i, "--collective-max-latency-ms"),
                    "--collective-max-latency-ms",
                )
                break
            case "--model":
                args.model = required(argv, ++i, "--model")
                break
            case "--no-git":
                args.noGit = true
                break
            case "--continue":
                args.continueRun = true
                break
            case "--no-tui-events":
                args.noTuiEvents = true
                break
            case "--audit-log":
                args.auditLog = required(argv, ++i, "--audit-log")
                break
            case "--with-critic":
                args.withCritic = true
                break
            case "--critic-model":
                args.criticModel = required(argv, ++i, "--critic-model")
                break
            case "--no-librarian":
                args.noLibrarian = true
                break
            case "--no-memory":
                args.noMemory = true
                break
            case "--no-sentry":
                args.noSentry = true
                break
            case "--with-surgeon":
                args.withSurgeon = true
                break
            case "--surgeon-use-llm":
                args.surgeonUseLlm = true
                break
            case "--no-surgeon-llm":
                args.surgeonUseLlm = false
                break
            case "--no-surgeon":
                args.withSurgeon = false
                break
            case "--no-supervisor":
                args.withSupervisor = false
                break
            case "--with-supervisor":
                args.withSupervisor = true
                break
            case "--with-dialogue":
                args.withDialogue = true
                break
            case "--dialogue-llm": {
                const value = required(argv, ++i, "--dialogue-llm")
                if (value !== "claude" && value !== "openai") {
                    process.stderr.write(
                        `[cli] --dialogue-llm must be 'claude' or 'openai', got '${value}'\n`,
                    )
                    process.exit(2)
                }
                args.dialogueLlm = value
                break
            }
            case "--dialogue-model":
                args.dialogueModel = required(argv, ++i, "--dialogue-model")
                break
            case "--surgeon-model":
                args.surgeonModel = required(argv, ++i, "--surgeon-model")
                break
            case "--intra-level-delay":
                args.intraLevelDelaySecs = parseInt(
                    required(argv, ++i, "--intra-level-delay"),
                    10,
                )
                break
            case "--story-model":
                args.storyModel = required(argv, ++i, "--story-model")
                break
            case "--tier-map":
                try {
                    args.tierMap = parseTierMap(required(argv, ++i, "--tier-map"))
                } catch (e) {
                    process.stderr.write(`[cli] ${(e as Error).message}\n`)
                    process.exit(2)
                }
                break
            case "--openai-endpoint":
                args.endpointSpecs.push(required(argv, ++i, "--openai-endpoint"))
                break
            case "--effort":
                args.effort = required(argv, ++i, "--effort")
                break
            case "--llm": {
                const v = required(argv, ++i, "--llm")
                if (v !== "claude" && v !== "openai" && v !== "codex" && v !== "opencode" && v !== "pi") {
                    process.stderr.write(
                        `[cli] --llm must be 'claude' | 'openai' | 'codex' | 'opencode' | 'pi', got '${v}'\n`,
                    )
                    process.exit(2)
                }
                args.llm = v
                break
            }
            case "--story-llm":
            case "--critic-llm":
            case "--surgeon-llm": {
                const v = required(argv, ++i, a)
                if (v !== "claude" && v !== "openai" && v !== "codex" && v !== "opencode" && v !== "pi") {
                    process.stderr.write(
                        `[cli] ${a} must be 'claude' | 'openai' | 'codex' | 'opencode' | 'pi', got '${v}'\n`,
                    )
                    process.exit(2)
                }
                if (a === "--story-llm") args.storyLlm = v
                else if (a === "--critic-llm") args.criticLlm = v
                else args.surgeonLlm = v
                break
            }
            default:
                process.stderr.write(`[cli] unknown flag: ${a}\n`)
                process.exit(2)
        }
    }
    return args
}

function required(argv: string[], i: number, flag: string): string {
    const v = argv[i]
    if (v == null) {
        process.stderr.write(`[cli] flag ${flag} requires a value\n`)
        process.exit(2)
    }
    return v
}

function nonNegativeNumber(raw: string, flag: string): number {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
        process.stderr.write(`[cli] ${flag} must be a finite non-negative number\n`)
        process.exit(2)
    }
    return value
}

function probability(raw: string, flag: string): number {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        process.stderr.write(`[cli] ${flag} must be between 0 and 1\n`)
        process.exit(2)
    }
    return value
}

function optionalEnvNumber(
    name: string,
    parse: (raw: string, label: string) => number,
): number | undefined {
    const raw = process.env[name]
    return raw === undefined ? undefined : parse(raw, name)
}

function printHelp(): void {
    process.stdout.write(
        [
            "baro-orchestrator CLI",
            "",
            "Usage:",
            "  cli.ts --prd <path> --cwd <path> [options]",
            "",
            "Options:",
            "  --prd <path>          Path to prd.json (default: ./prd.json)",
            "  --cwd <path>          Working directory (default: .)",
            "  --parallel <N>        Max parallel stories per level (0 = unlimited)",
            "  --timeout <secs>      Per-story timeout (default: auto — effort-scaled; any value overrides)",
            "  --coordination <mode> Coordination engine: legacy|collective (default: legacy)",
            "  --local-only          Disable Baro-owned pushes/PRs (use a remote-free clone for hard isolation)",
            "  --collective-workers <json>  Candidate array file for opt-in worker bidding",
            "  --collective-bid-window-ms <N>  Local bid collection window (default: 50)",
            "  --collective-min-success <0..1>  Reject lower-confidence bids",
            "  --collective-max-cost-usd <N>    Reject bids above expected attempt cost",
            "  --collective-max-latency-ms <N>  Reject bids above estimated latency",
            "  --model <name>        Override model (opus, sonnet, haiku)",
            "  --no-git              Skip git lifecycle (branch / push)",
            "  --no-tui-events       Skip BaroEvent JSON emission",
            "  --audit-log <path>    Persist all bus events to JSONL",
            "  --with-critic         Enable Critic (live acceptance evaluator)",
            "  --critic-model <name> Model for Critic (default: haiku)",
            "  --with-dialogue       Enable collective conversation participant (no control authority)",
            "  --dialogue-llm <name> Text-only dialogue backend: claude|openai (default: claude)",
            "  --dialogue-model <id> Model for the optional DialogueAgent",
            "  --no-librarian        Disable Librarian (cross-agent memory)",
            "  --no-memory           Disable semantic memory (uses tag-based Librarian instead)",
            "  --no-sentry           Disable Sentry (file conflict detector)",
            "  --with-surgeon        Enable Surgeon (adaptive DAG mutation; default: on)",
            "  --no-surgeon          Disable Surgeon",
            "  --surgeon-use-llm     Use LLM evaluation in Surgeon (default: on)",
            "  --no-surgeon-llm      Use deterministic Surgeon evaluation",
            "  --surgeon-model <name> Model for Surgeon LLM (default: opus)",
            "  --intra-level-delay <secs>  Stagger story spawns within a level (default: 10, 0 disables)",
            "  --tier-map <spec>     Bind per-story tiers to backends, e.g.",
            "                        'light=openai:MiniMax-M3,standard=openai:MiniMax-M3,heavy=claude:opus'",
            "                        (also read from BARO_TIER_MAP). Lets one DAG mix claude/openai/codex.",
            "                        Legacy tier spellings haiku/sonnet/opus are accepted as aliases.",
            "  --openai-endpoint <name=url>  Register a named OpenAI-compatible endpoint (repeatable).",
            "                        Reference it from a route as openai:<model>@<name>, e.g.",
            "                        --openai-endpoint minimax=https://api.minimax.io/v1",
            "                        --tier-map 'light=openai:MiniMax-M3@minimax,heavy=claude:opus'",
            "                        Key per endpoint: BARO_OPENAI_KEY_<NAME> env, else OPENAI_API_KEY.",
            "  -h, --help            Show this message",
            "",
        ].join("\n"),
    )
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
        printHelp()
        return
    }

    const envCoordination = process.env.BARO_COORDINATION
    if (
        !args.coordinationMode &&
        envCoordination &&
        envCoordination !== "legacy" &&
        envCoordination !== "collective"
    ) {
        process.stderr.write(
            `[cli] BARO_COORDINATION must be 'legacy' or 'collective', got '${envCoordination}'\n`,
        )
        process.exit(2)
    }
    const coordinationMode =
        args.coordinationMode ??
        (envCoordination as CoordinationMode | undefined) ??
        "legacy"
    const localOnly = args.localOnly || process.env.BARO_LOCAL_ONLY === "1"
    const withDialogue = args.withDialogue || process.env.BARO_WITH_DIALOGUE === "1"
    const dialogueLlm = args.dialogueLlm ?? parseDialogueBackend(
        process.env.BARO_DIALOGUE_LLM,
        "BARO_DIALOGUE_LLM",
    )
    const dialogueModel = args.dialogueModel ?? process.env.BARO_DIALOGUE_MODEL
    if (withDialogue && coordinationMode !== "collective") {
        process.stderr.write("[cli] --with-dialogue requires --coordination collective\n")
        process.exit(2)
    }
    const collectiveBidWindowMs = args.collectiveBidWindowMs ?? optionalEnvNumber(
        "BARO_COLLECTIVE_BID_WINDOW_MS",
        nonNegativeNumber,
    )
    const collectiveMinSuccessProbability =
        args.collectiveMinSuccessProbability ?? optionalEnvNumber(
            "BARO_COLLECTIVE_MIN_SUCCESS",
            probability,
        )
    const collectiveMaxCostUsd = args.collectiveMaxCostUsd ?? optionalEnvNumber(
        "BARO_COLLECTIVE_MAX_COST_USD",
        nonNegativeNumber,
    )
    const collectiveMaxLatencyMs = args.collectiveMaxLatencyMs ?? optionalEnvNumber(
        "BARO_COLLECTIVE_MAX_LATENCY_MS",
        nonNegativeNumber,
    )

    // `--tier-map` wins; otherwise fall back to BARO_TIER_MAP env (how
    // the Rust TUI forwards the operator's choice to this subprocess).
    let tierMap = args.tierMap
    if (!tierMap && process.env.BARO_TIER_MAP) {
        try {
            tierMap = parseTierMap(process.env.BARO_TIER_MAP)
        } catch (e) {
            process.stderr.write(`[cli] BARO_TIER_MAP: ${(e as Error).message}\n`)
            process.exit(2)
        }
    }

    // API keys come from env (per-endpoint BARO_OPENAI_KEY_<NAME>, else
    // OPENAI_API_KEY) so secrets never travel on the command line. Specs:
    // repeated --openai-endpoint flags, else BARO_OPENAI_ENDPOINTS (comma-sep).
    let endpointSpecs = args.endpointSpecs
    if (endpointSpecs.length === 0 && process.env.BARO_OPENAI_ENDPOINTS) {
        endpointSpecs = process.env.BARO_OPENAI_ENDPOINTS.split(",")
    }
    let openaiEndpoints: EndpointMap | undefined
    if (endpointSpecs.length > 0) {
        try {
            openaiEndpoints = parseEndpoints(endpointSpecs, (name) => {
                const envName =
                    "BARO_OPENAI_KEY_" + name.toUpperCase().replace(/[^A-Z0-9]/g, "_")
                return process.env[envName] ?? process.env.OPENAI_API_KEY
            })
        } catch (e) {
            process.stderr.write(`[cli] ${(e as Error).message}\n`)
            process.exit(2)
        }
    }

    // Fail fast: every endpoint a tier-map route references must resolve.
    if (tierMap) {
        for (const route of Object.values(tierMap)) {
            try {
                resolveStoryRoute(route, {
                    fallbackBackend: args.llm,
                    endpoints: openaiEndpoints,
                    defaultApiKey: process.env.OPENAI_API_KEY,
                })
            } catch (e) {
                process.stderr.write(
                    `[cli] tier-map route "${route}": ${(e as Error).message}\n`,
                )
                process.exit(2)
            }
        }
    }

    const cwd = resolve(args.cwd)
    const prdPath = resolve(cwd, args.prd)
    if (!existsSync(prdPath)) {
        process.stderr.write(`[cli] PRD not found: ${prdPath}\n`)
        process.exit(2)
    }
    const workersFile =
        args.collectiveWorkersFile ?? process.env.BARO_COLLECTIVE_WORKERS_FILE
    let collectiveWorkers: CollectiveWorkerCandidateConfig[] | undefined
    if (workersFile) {
        const path = resolve(cwd, workersFile)
        try {
            const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
            if (!Array.isArray(parsed)) {
                throw new Error("top-level JSON value must be an array")
            }
            collectiveWorkers = parsed as CollectiveWorkerCandidateConfig[]
            validateCollectiveWorkers(
                collectiveWorkers,
                coordinationMode,
                args.storyModel,
            )
            for (const [index, worker] of collectiveWorkers.entries()) {
                if (worker?.estimate?.estimateSource !== "configured") {
                    throw new Error(
                        `worker[${index}].estimate.estimateSource must be 'configured' in a static candidate file`,
                    )
                }
            }
        } catch (error) {
            process.stderr.write(
                `[cli] invalid collective workers file ${path}: ${(error as Error).message}\n`,
            )
            process.exit(2)
        }
    }
    const hasMarketPolicy =
        collectiveMinSuccessProbability !== undefined ||
        collectiveMaxCostUsd !== undefined ||
        collectiveMaxLatencyMs !== undefined
    if (workersFile && collectiveWorkers?.length === 0) {
        process.stderr.write("[cli] collective workers file must contain at least one candidate\n")
        process.exit(2)
    }
    if (
        (workersFile || collectiveBidWindowMs !== undefined || hasMarketPolicy) &&
        coordinationMode !== "collective"
    ) {
        process.stderr.write("[cli] collective market options require --coordination collective\n")
        process.exit(2)
    }
    if (
        !collectiveWorkers?.length &&
        (collectiveBidWindowMs !== undefined || hasMarketPolicy)
    ) {
        process.stderr.write("[cli] collective bid window/policy requires --collective-workers\n")
        process.exit(2)
    }

    // TUI→orchestrator command lane on stdin (agent chat). The Operator
    // joins the bus a beat after startup; commands arriving before that
    // are dropped, like any other malformed/unknown line.
    let operatorRef: Operator | null = null
    subscribeCommands((cmd) => {
        handleStdinCommand(cmd, { getOperator: () => operatorRef })
    })

    const config: OrchestrateConfig = {
        prdPath,
        cwd,
        onOperatorReady: (operator) => {
            operatorRef = operator
        },
        parallel: args.parallel,
        timeoutSecs: args.timeout,
        coordinationMode,
        publishRemote: !localOnly,
        collectiveWorkers,
        collectiveBidWindowMs,
        collectiveBidPolicy:
            hasMarketPolicy
                ? {
                      minSuccessProbability: collectiveMinSuccessProbability,
                      maxCostUsd: collectiveMaxCostUsd,
                      maxLatencyMs: collectiveMaxLatencyMs,
                  }
                : undefined,
        overrideModel: args.model ?? null,
        defaultModel: args.model ?? "sonnet",
        emitTuiEvents: !args.noTuiEvents,
        withGit: args.noGit ? false : undefined,
        continueRun: args.continueRun || process.env.BARO_CONTINUE === "1",
        auditLogPath: args.auditLog,
        withCritic: args.withCritic,
        criticModel: args.criticModel,
        withDialogue,
        dialogueLlm,
        dialogueModel,
        withLibrarian: args.noLibrarian ? false : undefined,
        withMemory: args.noMemory ? false : undefined,
        withSentry: args.noSentry ? false : undefined,
        withSurgeon: args.withSurgeon,
        surgeonUseLlm: args.surgeonUseLlm,
        withSupervisor: args.withSupervisor,
        surgeonModel: args.surgeonModel,
        intraLevelDelaySecs: args.intraLevelDelaySecs,
        llm: args.llm,
        storyLlm: args.storyLlm,
        criticLlm: args.criticLlm,
        surgeonLlm: args.surgeonLlm,
        storyModel: args.storyModel,
        effort: args.effort,
        tierMap,
        openaiEndpoints,
    }

    if (
        ([args.llm, args.storyLlm, args.criticLlm, args.surgeonLlm].includes("openai") ||
            (withDialogue && dialogueLlm === "openai") ||
            collectiveWorkers?.some((worker) => worker.route.startsWith("openai:"))) &&
        !process.env.OPENAI_API_KEY
    ) {
        process.stderr.write(
            "[cli] WARNING: an OpenAI phase was requested but OPENAI_API_KEY is not set.\n" +
            "[cli]          Configure OPENAI_API_KEY or a keyed named endpoint before running.\n",
        )
    }

    process.stderr.write(
        `[cli] starting orchestrator: prd=${prdPath} cwd=${cwd} parallel=${args.parallel} timeout=${args.timeout}s llm=${args.llm} coordination=${coordinationMode}${localOnly ? " local-only" : ""}\n`,
    )

    const startedAt = Date.now()
    try {
        const result = await orchestrate(config)
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        const passed = result.summary.completedStories.length
        const failed = result.summary.failedStories.length
        const dropped = result.summary.droppedStories.length
        process.stderr.write(
            `[cli] complete in ${elapsed}s — ${passed} passed, ${failed} failed, ${dropped} dropped (${result.summary.totalAttempts} attempts)\n`,
        )
        if (!result.summary.success) {
            if (failed > 0) {
                process.stderr.write(
                    `[cli] failed stories: ${result.summary.failedStories.join(", ")}\n`,
                )
            }
            if (dropped > 0) {
                process.stderr.write(
                    `[cli] dropped stories: ${result.summary.droppedStories.join(", ")}\n`,
                )
            }
            if (result.summary.abortReason) {
                process.stderr.write(`[cli] stopped: ${result.summary.abortReason}\n`)
            }
            process.exit(1)
        }
        // Explicit exit — open handles (ONNX model, Mozaik timers) prevent
        // natural Node exit after orchestrate() resolves.
        process.exit(0)
    } catch (e) {
        process.stderr.write(
            `[cli] fatal: ${(e as Error)?.stack ?? String(e)}\n`,
        )
        process.exit(1)
    }
}

function parseDialogueBackend(
    value: string | undefined,
    label: string,
): "claude" | "openai" | undefined {
    if (value === undefined || value === "") return undefined
    if (value === "claude" || value === "openai") return value
    process.stderr.write(`[cli] ${label} must be 'claude' or 'openai', got '${value}'\n`)
    process.exit(2)
}

// Without these guards, an unhandled rejection in a Participant's
// onContextItem handler kills the orchestrator silently and the TUI is
// left in "Waiting for next story…" forever.
process.on("unhandledRejection", (reason) => {
    const stack = (reason as Error)?.stack ?? String(reason)
    process.stderr.write(`[cli] unhandledRejection: ${stack}\n`)
    ClaudeCliParticipant.killAll("SIGTERM")
    process.exit(1)
})
process.on("uncaughtException", (err) => {
    const stack = err?.stack ?? String(err)
    process.stderr.write(`[cli] uncaughtException: ${stack}\n`)
    ClaudeCliParticipant.killAll("SIGTERM")
    process.exit(1)
})

// Forward SIGINT/SIGTERM to every active child so a killed baro doesn't
// leave a swarm of agents burning quota. The Rust TUI sends SIGTERM on
// shutdown; a dev ctrl-c arrives as SIGINT.
let shuttingDown = false
function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(`[cli] received ${signal}, killing in-flight children...\n`)
    ClaudeCliParticipant.killAll("SIGTERM")
    CodexCliParticipant.killAll("SIGTERM")
    OpenCodeCliParticipant.killAll("SIGTERM")
    PiCliParticipant.killAll("SIGTERM")
    // Give children a moment to die cleanly, then escalate.
    setTimeout(() => {
        ClaudeCliParticipant.killAll("SIGKILL")
        CodexCliParticipant.killAll("SIGKILL")
        OpenCodeCliParticipant.killAll("SIGKILL")
        PiCliParticipant.killAll("SIGKILL")
        process.exit(signal === "SIGINT" ? 130 : 143)
    }, 1500).unref()
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

// Parent-death watchdog: a SIGKILLed Rust TUI can't send us SIGTERM, so
// detect re-parenting (ppid change → init/launchd) and self-terminate,
// killing our children on the way out. Any ppid change is fatal.
const initialPpid = process.ppid
const orphanWatchdog = setInterval(() => {
    if (process.ppid !== initialPpid) {
        process.stderr.write(
            `[cli] parent died (ppid ${initialPpid} → ${process.ppid}), shutting down\n`,
        )
        clearInterval(orphanWatchdog)
        shutdown("SIGTERM")
    }
}, 1000)
orphanWatchdog.unref()

main().catch((e: unknown) => {
    process.stderr.write(`[cli] unhandled: ${(e as Error)?.stack ?? String(e)}\n`)
    // process.exit() gives no grace window for SIGTERM to land, so SIGKILL
    // directly — otherwise a crash orphans live agent subprocesses that keep
    // burning quota and holding worktrees.
    ClaudeCliParticipant.killAll("SIGKILL")
    CodexCliParticipant.killAll("SIGKILL")
    OpenCodeCliParticipant.killAll("SIGKILL")
    PiCliParticipant.killAll("SIGKILL")
    process.exit(1)
})
