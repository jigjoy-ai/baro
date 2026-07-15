/**
 * Planner CLI — the Rust TUI invokes this as a subprocess instead of
 * shelling out to `claude` directly. With `--result-file` the PRD JSON is
 * written to that file and STDOUT becomes the live BaroEvent stream (the
 * Rust runner forwards it to the feed); without it, STDOUT is the bare PRD
 * JSON (legacy). Stderr = debug + errors either way; non-zero exit on failure.
 */

import { readFileSync, writeFileSync } from "fs"
import { randomUUID } from "node:crypto"

import {
    createGatewayBillingCoordinatorFromEnv,
    reconcileAndCloseGatewayBilling,
} from "../src/billing/index.js"
import { runPlannerClaude } from "../src/planning/planner-claude.js"
import { runPlannerCodex } from "../src/planning/planner-codex.js"
import { runPlannerOpenAI } from "../src/planning/planner-openai.js"
import { runPlannerOpenCode } from "../src/planning/planner-opencode.js"
import { runPlannerPi } from "../src/planning/planner-pi.js"
import { parseRequiredModeContract, type ModeContract } from "../src/planning/planner-prompts.js"
import { enforceModeContract } from "../src/planning/mode-enforcement.js"
import { assertRunnablePlannerPrdJson } from "../src/planning/planner-validation.js"
import {
    applyProgressiveBootstrapMetadata,
    parseProgressiveBootstrapMetadata,
    persistProgressivePlannerResult,
    ProgressivePlannerLifecycle,
    resolveProgressivePlannerConfig,
    type ProgressiveBootstrapMetadata,
} from "../src/planning/progressive-planner-protocol.js"
import { emit } from "../src/tui-protocol.js"

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
    /** When set, the PRD is written here and stdout is freed for the event stream. */
    resultFile?: string
    progressiveRunId?: string
    progressivePlanningId?: string
    progressiveBootstrapFile?: string
    quick: boolean
}

let activeProgressiveLifecycle: ProgressivePlannerLifecycle | undefined

function parseArgs(argv: string[]): Args {
    let goal: string | undefined
    let cwd: string | undefined
    let llm: "claude" | "openai" | "codex" | "opencode" | "pi" | undefined
    let model: string | undefined
    let effort: string | undefined
    let contextFile: string | undefined
    let decisionFile: string | undefined
    let modeFile: string | undefined
    let resultFile: string | undefined
    let progressiveRunId: string | undefined
    let progressivePlanningId: string | undefined
    let progressiveBootstrapFile: string | undefined
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
            case "--result-file":
                resultFile = required(argv, ++i, "--result-file")
                break
            case "--progressive-run-id":
                progressiveRunId = required(argv, ++i, "--progressive-run-id")
                break
            case "--progressive-planning-id":
                progressivePlanningId = required(
                    argv,
                    ++i,
                    "--progressive-planning-id",
                )
                break
            case "--progressive-bootstrap-file":
                progressiveBootstrapFile = required(
                    argv,
                    ++i,
                    "--progressive-bootstrap-file",
                )
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
        resultFile,
        progressiveRunId,
        progressivePlanningId,
        progressiveBootstrapFile,
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
    let progressiveConfig
    try {
        progressiveConfig = resolveProgressivePlannerConfig(args)
    } catch (error) {
        fatal((error as Error).message)
    }
    // With a result file, stdout is the event stream — let the planner emit.
    if (args.resultFile) process.env.BARO_PLAN_EVENTS = "1"
    const progressive = progressiveConfig
        ? new ProgressivePlannerLifecycle(progressiveConfig)
        : undefined
    progressive?.open()
    activeProgressiveLifecycle = progressive
    let bootstrapMetadata: ProgressiveBootstrapMetadata | undefined
    if (progressiveConfig) {
        try {
            bootstrapMetadata = parseProgressiveBootstrapMetadata(
                readFileSync(progressiveConfig.bootstrapFile, "utf8"),
                progressiveConfig.bootstrapFile,
            )
        } catch (error) {
            const reason = (error as Error)?.message ?? String(error)
            emitProgressiveFailure(progressive, "invalid_bootstrap", reason)
            fatal(`invalid --progressive-bootstrap-file: ${reason}`)
        }
    }
    const projectContext = tryRead(args.contextFile)
    const decisionDocument = tryRead(args.decisionFile)
    let modeContract: ModeContract | undefined
    if (args.modeFile) {
        try {
            modeContract = parseRequiredModeContract(readFileSync(args.modeFile, "utf-8"))
        } catch (e) {
            emitProgressiveFailure(
                progressive,
                "invalid_mode_contract",
                (e as Error).message,
            )
            fatal(`invalid --mode-file: ${(e as Error).message}`)
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
                emitProgressiveFailure(
                    progressive,
                    "missing_provider_credentials",
                    "--llm openai requires OPENAI_API_KEY to be set",
                )
                fatal("--llm openai requires OPENAI_API_KEY to be set")
            }
            const billing = createGatewayBillingCoordinatorFromEnv({
                runId: process.env.BARO_RUN_ID ?? `planner-${randomUUID()}`,
                publishMeasurement: (measurement) => {
                    if (process.env.BARO_PLAN_EVENTS === "1") {
                        emit({ type: "model_usage", measurement })
                    }
                },
            })
            try {
                prdJson = await runPlannerOpenAI({
                    goal: args.goal,
                    cwd: args.cwd,
                    model: args.model,
                    projectContext,
                    decisionDocument,
                    quick: args.quick,
                    modeContract,
                    billingCoordinator: billing ?? undefined,
                    ...(progressive
                        ? {
                              progressive: {
                                  runId: progressive.config.runId,
                                  planningId: progressive.config.planningId,
                                  publish: (event: unknown) =>
                                      progressive.publish(event),
                              },
                          }
                        : {}),
                })
            } finally {
                const result = await reconcileAndCloseGatewayBilling(billing)
                if (result && !result.complete) {
                    process.stderr.write(
                        `[run-planner] billing reconciliation incomplete (${result.unresolvedInvocationIds.length} invocation(s))\n`,
                    )
                }
            }
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
        emitProgressiveFailure(
            progressive,
            "planner_failed",
            (e as Error)?.message ?? String(e),
        )
        process.stderr.write(
            `[run-planner] FAILED after ${Date.now() - t0}ms: ${(e as Error)?.message ?? String(e)}\n`,
        )
        process.exit(1)
    }

    try {
        prdJson = assertRunnablePlannerPrdJson(prdJson)
        if (modeContract) {
            prdJson = enforceModeContract(prdJson, modeContract, args.goal)
        }
        prdJson = assertRunnablePlannerPrdJson(prdJson)
        if (bootstrapMetadata) {
            prdJson = applyProgressiveBootstrapMetadata(
                prdJson,
                bootstrapMetadata,
            )
            prdJson = assertRunnablePlannerPrdJson(prdJson)
        }
    } catch (e) {
        emitProgressiveFailure(
            progressive,
            "invalid_final_plan",
            (e as Error)?.message ?? String(e),
        )
        process.stderr.write(
            `[run-planner] FAILED after ${Date.now() - t0}ms: ${(e as Error)?.message ?? String(e)}\n`,
        )
        process.exit(1)
    }

    process.stderr.write(
        `[run-planner] ok in ${Date.now() - t0}ms (${prdJson.length} chars)\n`,
    )
    // Result to the file (stdout is the event stream); legacy path keeps it on stdout.
    if (args.resultFile) {
        try {
            if (progressive) {
                persistProgressivePlannerResult(
                    args.resultFile,
                    prdJson,
                    progressive,
                )
            } else {
                writeFileSync(args.resultFile, prdJson)
            }
        } catch (error) {
            if (!progressive) throw error
            const reason = (error as Error)?.message ?? String(error)
            emitProgressiveFailure(progressive, "result_finalize_failed", reason)
            process.stderr.write(
                `[run-planner] FAILED after ${Date.now() - t0}ms: ${reason}\n`,
            )
            process.exit(1)
        }
    } else {
        process.stdout.write(prdJson)
    }
}

function emitProgressiveFailure(
    lifecycle: ProgressivePlannerLifecycle | undefined,
    code: string,
    reason: string,
): void {
    try {
        lifecycle?.fail(code, reason)
    } catch {
        // Preserve the original non-zero failure even if stdout itself closed.
    }
}

main().catch((e) => {
    emitProgressiveFailure(
        activeProgressiveLifecycle,
        "planner_crashed",
        (e as Error)?.message ?? String(e),
    )
    process.stderr.write(`[run-planner] crashed: ${e?.stack ?? String(e)}\n`)
    process.exit(3)
})
