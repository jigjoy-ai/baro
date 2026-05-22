/**
 * Architect CLI — the Rust TUI invokes this as a subprocess instead
 * of shelling out to `claude` directly. Picks the right backend
 * based on `--llm`, prints the resulting markdown decision document
 * to stdout, exits 0 on success / non-zero on error (the error
 * message is on stderr in that case).
 *
 * Usage:
 *   tsx packages/baro-orchestrator/scripts/run-architect.ts \\
 *       --goal "Add JWT auth with role-based access control" \\
 *       --cwd /path/to/project \\
 *       --llm claude|openai \\
 *       [--model <model-name>] \\
 *       [--context-file CLAUDE.md]
 *
 * Stdout = markdown design document (or empty on error).
 * Stderr = progress notes + error message.
 */

import { readFileSync } from "fs"

import { runArchitectClaude } from "../src/planning/architect-claude.js"
import { runArchitectOpenAI } from "../src/planning/architect-openai.js"

interface Args {
    goal: string
    cwd: string
    /**
     * "codex" is accepted at the boundary but currently routes through
     * the Claude architect path — codex-architect.ts is a planned v2
     * follow-up to the codex story-agent backend. v1's positioning is:
     * Codex covers the Story phase (which dominates token spend);
     * Architect and Planner stay on Claude.
     */
    llm: "claude" | "openai" | "codex"
    model?: string
    contextFile?: string
}

function parseArgs(argv: string[]): Args {
    let goal: string | undefined
    let cwd: string | undefined
    let llm: "claude" | "openai" | "codex" | undefined
    let model: string | undefined
    let contextFile: string | undefined

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
            case "--context-file":
                contextFile = required(argv, ++i, "--context-file")
                break
            default:
                fatal(`unknown flag: ${a}`)
        }
    }
    if (!goal) fatal("--goal is required")
    if (!cwd) fatal("--cwd is required")
    if (!llm) fatal("--llm is required")
    return { goal: goal!, cwd: cwd!, llm: llm!, model, contextFile }
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

    // Codex is accepted at the boundary but routes to the Claude
    // architect path in v1 — codex-architect.ts is a follow-up. Log
    // explicitly so it's clear from the audit log which backend
    // actually ran the architect phase, even when `--llm codex` was
    // requested at the CLI.
    const architectBackend =
        args.llm === "openai" ? "openai" : "claude"
    process.stderr.write(
        `[run-architect] requested=${args.llm} → architect-backend=${architectBackend} model=${args.model ?? "(default)"}\n`,
    )

    let doc: string
    const t0 = Date.now()
    try {
        if (architectBackend === "openai") {
            if (!process.env.OPENAI_API_KEY) {
                fatal("--llm openai requires OPENAI_API_KEY to be set")
            }
            doc = await runArchitectOpenAI({
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
    process.stdout.write(doc)
}

main().catch((e) => {
    process.stderr.write(`[run-architect] crashed: ${e?.stack ?? String(e)}\n`)
    process.exit(3)
})
