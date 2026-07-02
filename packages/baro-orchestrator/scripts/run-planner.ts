/**
 * Planner CLI — the Rust TUI invokes this as a subprocess instead of
 * shelling out to `claude` directly. Stdout = bare PRD JSON, the shape
 * Rust's `PrdOutput` deserialises; stderr = progress + errors; non-zero
 * exit on failure.
 */

import { readFileSync } from "fs"

import { runPlannerClaude } from "../src/planning/planner-claude.js"
import { runPlannerCodex } from "../src/planning/planner-codex.js"
import { runPlannerOpenAI } from "../src/planning/planner-openai.js"
import { runPlannerOpenCode } from "../src/planning/planner-opencode.js"
import { runPlannerPi } from "../src/planning/planner-pi.js"
import { parseModeContract, type ModeContract } from "../src/planning/planner-prompts.js"
import { enforceModeContract } from "../src/planning/mode-enforcement.js"

interface Args {
    goal: string
    cwd: string
    /**
     * "codex" is accepted at the boundary but currently routes through the
     * Claude planner path — codex-planner.ts is a v2 follow-up.
     */
    llm: "claude" | "openai" | "codex" | "opencode" | "pi"
    model?: string
    effort?: string
    contextFile?: string
    decisionFile?: string
    /** JSON ModeContract from the run-intake step (user-confirmed); skips planner intake. */
    modeFile?: string
    quick: boolean
}

function parseArgs(argv: string[]): Args {
    let goal: string | undefined
    let cwd: string | undefined
    let llm: "claude" | "openai" | "codex" | "opencode" | "pi" | undefined
    let model: string | undefined
    let effort: string | undefined
    let contextFile: string | undefined
    let decisionFile: string | undefined
    let modeFile: string | undefined
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
            case "--decision-file":
                decisionFile = required(argv, ++i, "--decision-file")
                break
            case "--mode-file":
                modeFile = required(argv, ++i, "--mode-file")
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
        modeFile,
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
    let modeContract: ModeContract | undefined
    const modeJson = tryRead(args.modeFile)
    if (modeJson) {
        try {
            modeContract = parseModeContract(modeJson)
        } catch (e) {
            process.stderr.write(
                `[run-planner] warning: invalid --mode-file (${(e as Error).message}) — planner will run its own intake\n`,
            )
        }
    }

    process.stderr.write(
        `[run-planner] llm=${args.llm} model=${args.model ?? "(default)"} quick=${args.quick}` +
            (modeContract ? ` mode=${modeContract.mode} (pre-decided)` : "") +
            "\n",
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
                modeContract,
            })
        } else if (args.llm === "codex") {
            prdJson = await runPlannerCodex({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
                decisionDocument,
                quick: args.quick,
                modeContract,
            })
        } else if (args.llm === "opencode") {
            prdJson = await runPlannerOpenCode({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
                decisionDocument,
                quick: args.quick,
                modeContract,
            })
        } else if (args.llm === "pi") {
            prdJson = await runPlannerPi({
                goal: args.goal,
                cwd: args.cwd,
                model: args.model,
                projectContext,
                decisionDocument,
                quick: args.quick,
                modeContract,
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
                modeContract,
            })
        }
    } catch (e) {
        process.stderr.write(
            `[run-planner] FAILED after ${Date.now() - t0}ms: ${(e as Error)?.message ?? String(e)}\n`,
        )
        process.exit(1)
    }

    if (modeContract) {
        prdJson = enforceModeContract(prdJson, modeContract, args.goal)
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
