/**
 * Architect CLI — the Rust TUI invokes this as a subprocess instead of
 * shelling out to `claude` directly. With `--result-file` the markdown
 * decision document is written to that file and STDOUT becomes the live
 * BaroEvent stream (the Rust runner forwards it to the feed); without it,
 * STDOUT is the doc (legacy). Stderr = debug + errors; non-zero exit on failure.
 */

import { readFileSync, writeFileSync } from "fs"

import { runArchitectClaude } from "../src/planning/architect-claude.js"
import { runArchitectCodex } from "../src/planning/architect-codex.js"
import { runArchitectOpenAI } from "../src/planning/architect-openai.js"
import { runArchitectOpenCode } from "../src/planning/architect-opencode.js"
import { runArchitectPi } from "../src/planning/architect-pi.js"

interface Args {
    goal: string
    cwd: string
    /**
     * "codex" is accepted at the boundary but currently routes through the
     * Claude architect path — codex-architect.ts is a planned v2 follow-up.
     * v1: Codex covers the Story phase; Architect/Planner stay on Claude.
     */
    llm: "claude" | "openai" | "codex" | "opencode" | "pi"
    model?: string
    effort?: string
    contextFile?: string
    /** When set, the doc is written here and stdout is freed for the event stream. */
    resultFile?: string
}

function parseArgs(argv: string[]): Args {
    let goal: string | undefined
    let cwd: string | undefined
    let llm: "claude" | "openai" | "codex" | "opencode" | "pi" | undefined
    let model: string | undefined
    let effort: string | undefined
    let contextFile: string | undefined
    let resultFile: string | undefined

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case "--goal":
                goal = required(argv, ++i, "--goal")
                break
            case "--cwd":
                cwd = required(argv, ++i, "--cwd")
                break
            case "--llm": {
                const v = required(argv, ++i, "--llm")
                if (v !== "claude" && v !== "openai" && v !== "codex" && v !== "opencode" && v !== "pi") {
                    fatal(`--llm must be 'claude' | 'openai' | 'codex' | 'opencode' | 'pi', got '${v}'`)
                }
                llm = v as "claude" | "openai" | "codex" | "opencode" | "pi"
                break
            }
            case "--model":
                model = required(argv, ++i, "--model")
                break
            case "--effort":
                effort = required(argv, ++i, "--effort")
                break
            case "--context-file":
                contextFile = required(argv, ++i, "--context-file")
                break
            case "--result-file":
                resultFile = required(argv, ++i, "--result-file")
                break
            default:
                fatal(`unknown flag: ${a}`)
        }
    }
    if (!goal) fatal("--goal is required")
    if (!cwd) fatal("--cwd is required")
    if (!llm) fatal("--llm is required")
    return { goal: goal!, cwd: cwd!, llm: llm!, model, effort, contextFile, resultFile }
}

function required(argv: string[], i: number, flag: string): string {
    const v = argv[i]
    if (v == null) fatal(`flag ${flag} requires a value`)
    return v!
}

function fatal(msg: string): never {
    process.stderr.write(`[run-architect] ${msg}\n`)
    process.exit(2)
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    // With a result file, stdout is the event stream — let the architect emit.
    if (args.resultFile) process.env.BARO_PLAN_EVENTS = "1"

    let projectContext: string | undefined
    if (args.contextFile) {
        try {
            projectContext = readFileSync(args.contextFile, "utf-8")
        } catch (e) {
            process.stderr.write(
                `[run-architect] warning: could not read context file ${args.contextFile}: ${(e as Error).message}\n`,
            )
        }
    }

    process.stderr.write(
        `[run-architect] llm=${args.llm} model=${args.model ?? "(default)"}\n`,
    )

    let doc: string
    const t0 = Date.now()
    try {
        if (args.llm === "openai") {
            if (!process.env.OPENAI_API_KEY) {
                fatal("--llm openai requires OPENAI_API_KEY to be set")
            }
            doc = await runArchitectOpenAI({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
            })
        } else if (args.llm === "codex") {
            doc = await runArchitectCodex({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
            })
        } else if (args.llm === "opencode") {
            doc = await runArchitectOpenCode({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
            })
        } else if (args.llm === "pi") {
            doc = await runArchitectPi({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
            })
        } else {
            doc = await runArchitectClaude({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                effort: args.effort,
                projectContext,
            })
        }
    } catch (e) {
        process.stderr.write(
            `[run-architect] FAILED after ${Date.now() - t0}ms: ${(e as Error)?.message ?? String(e)}\n`,
        )
        process.exit(1)
    }

    process.stderr.write(`[run-architect] ok in ${Date.now() - t0}ms (${doc.length} chars)\n`)
    // Result to the file (stdout is the event stream); legacy path keeps it on stdout.
    if (args.resultFile) {
        writeFileSync(args.resultFile, doc)
    } else {
        process.stdout.write(doc)
    }
}

main().catch((e) => {
    process.stderr.write(`[run-architect] crashed: ${e?.stack ?? String(e)}\n`)
    process.exit(3)
})
