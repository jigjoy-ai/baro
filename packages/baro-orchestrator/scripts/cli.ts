/**
 * baro-orchestrator CLI — standalone entry for end-user testing.
 *
 * Until the Rust TUI is rewired to spawn this as a subprocess, you can
 * run the orchestrator directly:
 *
 *   tsx packages/baro-orchestrator/scripts/cli.ts \
 *       --prd ./prd.json \
 *       --cwd . \
 *       --parallel 0 \
 *       --timeout 600 \
 *       [--model sonnet|opus|haiku] \
 *       [--no-git] \
 *       [--no-tui-events] \
 *       [--audit-log ./audit.jsonl]
 *
 * Prints BaroEvents to stdout (one JSON per line) by default, plus a
 * compact human summary on stderr.
 */

import { existsSync } from "fs"
import { resolve } from "path"

import { orchestrate, type OrchestrateConfig } from "../src/orchestrate.js"
import { ClaudeCliParticipant } from "../src/participants/claude-cli-participant.js"

interface CliArgs {
    prd: string
    cwd: string
    parallel: number
    timeout: number
    model?: string
    noGit: boolean
    noTuiEvents: boolean
    auditLog?: string
    withCritic: boolean
    criticModel?: string
    noLibrarian: boolean
    noSentry: boolean
    withSurgeon: boolean
    surgeonUseLlm: boolean
    surgeonModel?: string
    storyModel?: string
    intraLevelDelaySecs?: number
    llm: "claude" | "openai"
    shareArchitectCache: boolean
    help: boolean
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        prd: "prd.json",
        cwd: ".",
        parallel: 0,
        timeout: 600,
        noGit: false,
        noTuiEvents: false,
        withCritic: false,
        noLibrarian: false,
        noSentry: false,
        withSurgeon: false,
        surgeonUseLlm: false,
        llm: "claude",
        shareArchitectCache: false,
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
            case "--model":
                args.model = required(argv, ++i, "--model")
                break
            case "--no-git":
                args.noGit = true
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
            case "--no-sentry":
                args.noSentry = true
                break
            case "--with-surgeon":
                args.withSurgeon = true
                break
            case "--surgeon-use-llm":
                args.surgeonUseLlm = true
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
            case "--llm": {
                const v = required(argv, ++i, "--llm")
                if (v !== "claude" && v !== "openai") {
                    process.stderr.write(`[cli] --llm must be 'claude' or 'openai', got '${v}'\n`)
                    process.exit(2)
                }
                args.llm = v
                break
            }
            case "--share-architect-cache":
                args.shareArchitectCache = true
                break
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
            "  --timeout <secs>      Per-story timeout (default: 600)",
            "  --model <name>        Override model (opus, sonnet, haiku)",
            "  --no-git              Skip git lifecycle (branch / push)",
            "  --no-tui-events       Skip BaroEvent JSON emission",
            "  --audit-log <path>    Persist all bus events to JSONL",
            "  --with-critic         Enable Critic (live acceptance evaluator)",
            "  --critic-model <name> Model for Critic (default: haiku)",
            "  --no-librarian        Disable Librarian (cross-agent memory)",
            "  --no-sentry           Disable Sentry (file conflict detector)",
            "  --with-surgeon        Enable Surgeon (adaptive DAG mutation)",
            "  --surgeon-use-llm     Use LLM evaluation in Surgeon (default: deterministic)",
            "  --surgeon-model <name> Model for Surgeon LLM (default: opus)",
            "  --intra-level-delay <secs>  Stagger story spawns within a level (default: 10, 0 disables)",
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

    const cwd = resolve(args.cwd)
    const prdPath = resolve(cwd, args.prd)
    if (!existsSync(prdPath)) {
        process.stderr.write(`[cli] PRD not found: ${prdPath}\n`)
        process.exit(2)
    }

    const config: OrchestrateConfig = {
        prdPath,
        cwd,
        parallel: args.parallel,
        timeoutSecs: args.timeout,
        overrideModel: args.model ?? null,
        defaultModel: args.model ?? "sonnet",
        emitTuiEvents: !args.noTuiEvents,
        withGit: args.noGit ? false : undefined,
        auditLogPath: args.auditLog,
        withCritic: args.withCritic,
        criticModel: args.criticModel,
        withLibrarian: args.noLibrarian ? false : undefined,
        withSentry: args.noSentry ? false : undefined,
        withSurgeon: args.withSurgeon,
        surgeonUseLlm: args.surgeonUseLlm,
        surgeonModel: args.surgeonModel,
        intraLevelDelaySecs: args.intraLevelDelaySecs,
        llm: args.llm,
        storyModel: args.storyModel,
        shareArchitectCache: args.shareArchitectCache,
    }

    if (args.llm === "openai" && !process.env.OPENAI_API_KEY) {
        process.stderr.write(
            "[cli] WARNING: --llm openai requested but OPENAI_API_KEY is not set.\n" +
            "[cli]          The current build falls through to Claude behaviour;\n" +
            "[cli]          set OPENAI_API_KEY before phase 3+ OpenAI siblings ship.\n",
        )
    }

    process.stderr.write(
        `[cli] starting orchestrator: prd=${prdPath} cwd=${cwd} parallel=${args.parallel} timeout=${args.timeout}s llm=${args.llm}\n`,
    )

    const startedAt = Date.now()
    try {
        const result = await orchestrate(config)
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        const passed = result.summary.completedStories.length
        const failed = result.summary.failedStories.length
        process.stderr.write(
            `[cli] complete in ${elapsed}s — ${passed} passed, ${failed} failed (${result.summary.totalAttempts} attempts)\n`,
        )
        if (failed > 0) {
            process.stderr.write(
                `[cli] failed stories: ${result.summary.failedStories.join(", ")}\n`,
            )
            process.exit(1)
        }
    } catch (e) {
        process.stderr.write(
            `[cli] fatal: ${(e as Error)?.stack ?? String(e)}\n`,
        )
        process.exit(1)
    }
}

// Catch-all guards so any async failure that isn't already inside
// main()'s try/catch still gets a stack on stderr before the process
// dies. Without these, an unhandled rejection in a Participant's
// onContextItem handler kills the orchestrator silently and the TUI
// is left in "Waiting for next story…" forever.
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

// Forward SIGINT/SIGTERM to every active Claude child so a killed baro
// doesn't leave a swarm of background agents burning quota. The Rust
// TUI sends SIGTERM on user-initiated shutdown; the user's own ctrl-c
// in dev arrives as SIGINT.
let shuttingDown = false
function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write(`[cli] received ${signal}, killing in-flight Claude children...\n`)
    ClaudeCliParticipant.killAll("SIGTERM")
    // Give children a moment to die cleanly, then escalate.
    setTimeout(() => {
        ClaudeCliParticipant.killAll("SIGKILL")
        process.exit(signal === "SIGINT" ? 130 : 143)
    }, 1500).unref()
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

// Parent-death watchdog: if the Rust TUI is killed with SIGKILL it has
// no chance to send us SIGTERM, and we'd be left running with our
// Claude children alive. Detect re-parenting to PID 1 (init / launchd)
// and self-terminate, killing our children on the way out. The
// orchestrator only ever has one legit parent (the Rust baro-tui or a
// dev tsx invocation), so any change is fatal.
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
    process.exit(1)
})
