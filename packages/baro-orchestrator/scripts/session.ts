/**
 * baro session — ONE long-lived process that does interactive planning
 * AND execution over a single event stream (issue #37, F0+F1 spike).
 *
 *   goal ─► PLAN (chat ⇄ draft DAG)  ─► run_plan ─► EXECUTE (orchestrate) ─► done
 *
 * Protocol (newline-delimited JSON, same channels the TUI/desktop use):
 *
 *   stdin  (commands):
 *     {"type":"plan_message","text":"split the service story"}
 *     {"type":"run_plan"}
 *     {"type":"shutdown"}
 *
 *   stdout (events):
 *     {"type":"plan_draft","project":…,"stories":[…],"levels":[[…]]}
 *     {"type":"plan_reply","text":…}            planner's human-facing reply
 *     {"type":"plan_error","text":…}            mutation rejected (e.g. cycle)
 *     {"type":"plan_committed","prd":"…path"}   draft written, switching to run
 *     …then the normal BaroEvent stream from orchestrate (init, dag, story_*, done)
 *
 * Usage:
 *   tsx scripts/session.ts --goal "Add a reservations module" --cwd . \
 *       [--planner-model opus] [--llm claude] [--tier-map …] [--no-git]
 *   then write commands to stdin.
 */

import { createInterface } from "readline"
import { resolve } from "path"

import { orchestrate, type OrchestrateConfig } from "../src/orchestrate.js"
import { savePrd, type PrdFile } from "../src/prd.js"
import { buildDag } from "../src/dag.js"
import { PlannerSession } from "../src/planning/planner-session.js"
import { parseTierMap, parseEndpoints, type EndpointMap } from "../src/routing.js"

interface Args {
    goal: string
    cwd: string
    prd: string
    plannerModel: string
    llm: "claude" | "openai" | "codex"
    noGit: boolean
    parallel: number
    effort?: string
    tierMap?: string
    endpointSpecs: string[]
}

function parseArgs(argv: string[]): Args {
    const a: Args = {
        goal: "",
        cwd: ".",
        prd: "prd.json",
        plannerModel: "opus",
        llm: "claude",
        noGit: false,
        parallel: 0,
        endpointSpecs: [],
    }
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]
        const val = () => {
            const v = argv[++i]
            if (v == null) {
                process.stderr.write(`[session] ${flag} needs a value\n`)
                process.exit(2)
            }
            return v
        }
        switch (flag) {
            case "--goal": a.goal = val(); break
            case "--cwd": a.cwd = val(); break
            case "--prd": a.prd = val(); break
            case "--planner-model": a.plannerModel = val(); break
            case "--llm": {
                const v = val()
                if (v !== "claude" && v !== "openai" && v !== "codex") {
                    process.stderr.write(`[session] --llm must be claude|openai|codex\n`)
                    process.exit(2)
                }
                a.llm = v
                break
            }
            case "--no-git": a.noGit = true; break
            case "--parallel": a.parallel = parseInt(val(), 10); break
            case "--effort": a.effort = val(); break
            case "--tier-map": a.tierMap = val(); break
            case "--openai-endpoint": a.endpointSpecs.push(val()); break
            default:
                process.stderr.write(`[session] unknown flag: ${flag}\n`)
                process.exit(2)
        }
    }
    if (!a.goal) {
        process.stderr.write("[session] --goal is required\n")
        process.exit(2)
    }
    return a
}

function emit(evt: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(evt) + "\n")
}

/** Emit the draft as a plan_draft event (stories + DAG levels for rendering). */
function emitDraft(draft: PrdFile): void {
    let levels: { id: string; model: string }[][] = []
    try {
        levels = buildDag(draft.userStories).map((lvl) =>
            lvl.storyIds.map((id) => ({
                id,
                model: draft.userStories.find((s) => s.id === id)?.model ?? "opus",
            })),
        )
    } catch {
        // A transiently-invalid draft still renders as a flat list.
    }
    emit({
        type: "plan_draft",
        project: draft.project,
        description: draft.description,
        stories: draft.userStories.map((s) => ({
            id: s.id,
            title: s.title,
            depends_on: s.dependsOn,
            model: s.model ?? "opus",
        })),
        levels,
    })
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const cwd = resolve(args.cwd)
    const prdPath = resolve(cwd, args.prd)

    let tierMap
    if (args.tierMap) {
        try { tierMap = parseTierMap(args.tierMap) } catch (e) {
            process.stderr.write(`[session] ${(e as Error).message}\n`); process.exit(2)
        }
    }
    let endpoints: EndpointMap | undefined
    if (args.endpointSpecs.length > 0) {
        try {
            endpoints = parseEndpoints(args.endpointSpecs, (name) =>
                process.env["BARO_OPENAI_KEY_" + name.toUpperCase().replace(/[^A-Z0-9]/g, "_")] ??
                process.env.OPENAI_API_KEY,
            )
        } catch (e) {
            process.stderr.write(`[session] ${(e as Error).message}\n`); process.exit(2)
        }
    }

    const session = new PlannerSession({ goal: args.goal, model: args.plannerModel })

    process.stderr.write(`[session] planning "${args.goal}" (planner=${args.plannerModel})\n`)
    emitDraft(await session.seed())

    const rl = createInterface({ input: process.stdin })
    let running = false

    for await (const line of rl) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let cmd: { type?: string; text?: string }
        try {
            cmd = JSON.parse(trimmed)
        } catch {
            emit({ type: "plan_error", text: `bad command JSON: ${trimmed}` })
            continue
        }

        if (cmd.type === "plan_message" && typeof cmd.text === "string") {
            try {
                const turn = await session.handleMessage(cmd.text)
                emit({ type: "plan_reply", text: turn.reply })
                if (turn.rejected) emit({ type: "plan_error", text: turn.rejected })
                emitDraft(turn.draft)
            } catch (e) {
                emit({ type: "plan_error", text: (e as Error).message })
            }
            continue
        }

        if (cmd.type === "run_plan") {
            if (!session.draft) { emit({ type: "plan_error", text: "no draft to run" }); continue }
            running = true
            rl.close()
            savePrd(prdPath, session.draft)
            emit({ type: "plan_committed", prd: prdPath })
            process.stderr.write(`[session] committed draft → ${prdPath}; executing\n`)
            // EXECUTE in the SAME process — orchestrate() emits the normal
            // BaroEvent stream to stdout (emitTuiEvents defaults on).
            const config: OrchestrateConfig = {
                prdPath,
                cwd,
                parallel: args.parallel,
                timeoutSecs: 0,
                llm: args.llm,
                withGit: args.noGit ? false : undefined,
                effort: args.effort,
                tierMap,
                openaiEndpoints: endpoints,
            }
            const result = await orchestrate(config)
            const failed = result.summary.failedStories.length
            process.stderr.write(`[session] run complete — ${failed} failed\n`)
            process.exit(failed > 0 ? 1 : 0)
        }

        if (cmd.type === "shutdown") {
            rl.close()
            process.exit(0)
        }

        emit({ type: "plan_error", text: `unknown command: ${cmd.type}` })
    }

    // stdin closed without run_plan → nothing to execute.
    if (!running) {
        process.stderr.write("[session] stdin closed before run_plan; exiting\n")
        process.exit(0)
    }
}

main().catch((e: unknown) => {
    process.stderr.write(`[session] fatal: ${(e as Error)?.stack ?? String(e)}\n`)
    process.exit(1)
})
