/**
 * Planner CLI — the Rust TUI invokes this as a subprocess instead of
 * shelling out to `claude` (or `node openai-planner.js`) directly.
 * Picks the right backend based on `--llm`, prints the PRD JSON to
 * stdout, exits 0 on success / non-zero on error.
 *
 * Stdout = bare PRD JSON, the shape Rust's `PrdOutput` deserialises.
 * Stderr = progress notes + error messages.
 *
 * Usage:
 *   tsx packages/baro-orchestrator/scripts/run-planner.ts \\
 *       --goal "Add JWT auth with RBAC" \\
 *       --cwd /path/to/project \\
 *       --llm claude|openai \\
 *       [--model <model-name>] \\
 *       [--context-file CLAUDE.md] \\
 *       [--decision-file <path>] \\
 *       [--quick]
 */

import { readFileSync } from "fs"

import { runPlannerClaude } from "../src/planning/planner-claude.js"
import { runPlannerCodex } from "../src/planning/planner-codex.js"
import { runPlannerOpenAI } from "../src/planning/planner-openai.js"
import { runPlannerOpenCode } from "../src/planning/planner-opencode.js"

interface Args {
    goal: string
    cwd: string
    /**
     * "codex" is accepted at the boundary but currently routes through
     * the Claude planner path — codex-planner.ts is a v2 follow-up.
     * v1 positioning: Codex covers the Story phase; Architect and
     * Planner stay on Claude.
     */
    llm: "claude" | "openai" | "codex" | "opencode"
    model?: string
    effort?: string
    contextFile?: string
    decisionFile?: string
    quick: boolean
}

function parseArgs(argv: string[]): Args {
    let goal: string | undefined
    let cwd: string | undefined
    let llm: "claude" | "openai" | "codex" | "opencode" | undefined
    let model: string | undefined
    let effort: string | undefined
    let contextFile: string | undefined
    let decisionFile: string | undefined
    let quick = false

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
                if (v !== "claude" && v !== "openai" && v !== "codex") {
                    fatal(`--llm must be 'claude' | 'openai' | 'codex', got '${v}'`)
                }
                llm = v as "claude" | "openai" | "codex"
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
            case "--decision-file":
                decisionFile = required(argv, ++i, "--decision-file")
                break
            case "--quick":
                quick = true
                break
            default:
                fatal(`unknown flag: ${a}`)
        }
    }
    if (!goal) fatal("--goal is required")
    if (!cwd) fatal("--cwd is required")
    if (!llm) fatal("--llm is required")
    return {
        goal: goal!,
        cwd: cwd!,
        llm: llm!,
        model,
        effort,
        contextFile,
        decisionFile,
        quick,
    }
}

function required(argv: string[], i: number, flag: string): string {
    const v = argv[i]
    if (v == null) fatal(`flag ${flag} requires a value`)
    return v!
}

function fatal(msg: string): never {
    process.stderr.write(`[run-planner] ${msg}\n`)
    process.exit(2)
}

function tryRead(path: string | undefined): string | undefined {
    if (!path) return undefined
    try {
        return readFileSync(path, "utf-8")
    } catch (e) {
        process.stderr.write(
            `[run-planner] warning: could not read ${path}: ${(e as Error).message}\n`,
        )
        return undefined
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const projectContext = tryRead(args.contextFile)
    const decisionDocument = tryRead(args.decisionFile)

    process.stderr.write(
        `[run-planner] llm=${args.llm} model=${args.model ?? "(default)"} quick=${args.quick}\n`,
    )

    let prdJson: string
    const t0 = Date.now()
    try {
        if (args.llm === "openai") {
            if (!process.env.OPENAI_API_KEY) {
                fatal("--llm openai requires OPENAI_API_KEY to be set")
            }
            prdJson = await runPlannerOpenAI({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
                decisionDocument,
                quick: args.quick,
            })
        } else if (args.llm === "codex") {
            prdJson = await runPlannerCodex({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
                decisionDocument,
                quick: args.quick,
            })
        } else if (args.llm === "opencode") {
            prdJson = await runPlannerOpenCode({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
                decisionDocument,
                quick: args.quick,
            })
        } else {
            prdJson = await runPlannerClaude({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                effort: args.effort,
                projectContext,
                decisionDocument,
                quick: args.quick,
            })
        }
    } catch (e) {
        process.stderr.write(
            `[run-planner] FAILED after ${Date.now() - t0}ms: ${(e as Error)?.message ?? String(e)}\n`,
        )
        process.exit(1)
    }

    process.stderr.write(
        `[run-planner] ok in ${Date.now() - t0}ms (${prdJson.length} chars)\n`,
    )
    process.stdout.write(prdJson)
}

main().catch((e) => {
    process.stderr.write(`[run-planner] crashed: ${e?.stack ?? String(e)}\n`)
    process.exit(3)
})
