/**
 * Intake CLI — classifies a goal into an execution-mode contract
 * (focused | sequential | parallel) BEFORE planning, so the Rust TUI can
 * show the proposal and let the user confirm/override. Stdout = ModeContract
 * JSON; stderr = progress; never fails hard (falls back to the heuristic).
 */

import { readFileSync } from "fs"

import {
    heuristicModeContract,
    type ModeContract,
} from "../src/planning/planner-prompts.js"
import { runClaudeIntake } from "../src/planning/planner-claude.js"
import { runCodexIntake } from "../src/planning/planner-codex.js"
import { runOpenAIIntake } from "../src/planning/planner-openai.js"
import { runOpenCodeIntake } from "../src/planning/planner-opencode.js"
import { runPiIntake } from "../src/planning/planner-pi.js"

interface Args {
    goal: string
    cwd: string
    llm: "claude" | "openai" | "codex" | "opencode" | "pi"
    model?: string
    contextFile?: string
    decisionFile?: string
    quick: boolean
}

function parseArgs(argv: string[]): Args {
    const args: Partial<Args> = { quick: false }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case "--goal":
                args.goal = required(argv, ++i, "--goal")
                break
            case "--cwd":
                args.cwd = required(argv, ++i, "--cwd")
                break
            case "--llm": {
                const v = required(argv, ++i, "--llm")
                if (v !== "claude" && v !== "openai" && v !== "codex" && v !== "opencode" && v !== "pi") {
                    fatal(`--llm must be 'claude' | 'openai' | 'codex' | 'opencode' | 'pi', got '${v}'`)
                }
                args.llm = v
                break
            }
            case "--model":
                args.model = required(argv, ++i, "--model")
                break
            case "--context-file":
                args.contextFile = required(argv, ++i, "--context-file")
                break
            case "--decision-file":
                args.decisionFile = required(argv, ++i, "--decision-file")
                break
            case "--quick":
                args.quick = true
                break
            default:
                fatal(`unknown flag: ${a}`)
        }
    }
    if (!args.goal) fatal("--goal is required")
    if (!args.cwd) fatal("--cwd is required")
    if (!args.llm) fatal("--llm is required")
    return args as Args
}

function required(argv: string[], i: number, flag: string): string {
    const v = argv[i]
    if (v == null) fatal(`flag ${flag} requires a value`)
    return v!
}

function fatal(msg: string): never {
    process.stderr.write(`[run-intake] ${msg}\n`)
    process.exit(2)
}

function tryRead(path: string | undefined): string | undefined {
    if (!path) return undefined
    try {
        return readFileSync(path, "utf-8")
    } catch {
        return undefined
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const opts = {
        goal: args.goal,
        cwd: args.cwd,
        model: args.model,
        quick: args.quick,
        projectContext: tryRead(args.contextFile),
        decisionDocument: tryRead(args.decisionFile),
    }

    let contract: ModeContract
    let source = "llm"
    const t0 = Date.now()
    try {
        if (args.llm === "openai") {
            if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set")
            contract = await runOpenAIIntake(opts)
        } else if (args.llm === "codex") {
            contract = await runCodexIntake(opts)
        } else if (args.llm === "opencode") {
            contract = await runOpenCodeIntake(opts)
        } else if (args.llm === "pi") {
            contract = await runPiIntake(opts)
        } else {
            contract = await runClaudeIntake(opts)
        }
    } catch (e) {
        process.stderr.write(
            `[run-intake] llm intake failed (${(e as Error)?.message ?? String(e)}) — using heuristic\n`,
        )
        contract = heuristicModeContract(opts)
        source = "heuristic"
    }
    process.stderr.write(
        `[run-intake] mode=${contract.mode} confidence=${contract.confidence} source=${source} in ${Date.now() - t0}ms\n`,
    )
    process.stdout.write(JSON.stringify({ ...contract, source }))
}

main().catch((e) => {
    process.stderr.write(`[run-intake] crashed: ${e?.stack ?? String(e)}\n`)
    process.exit(3)
})
