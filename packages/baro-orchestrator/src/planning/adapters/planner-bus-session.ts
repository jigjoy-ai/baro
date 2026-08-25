/**
 * Progressive planner as a collective bus participant.
 *
 * The subprocess planner lane (run-planner → stdout wire → Rust bridge →
 * orchestrator stdin) is one-way by construction: the planner's receipts are
 * computed locally in its own process and it never learns what the host
 * actually admitted, pruned, executed or merged. This session runs the same
 * Claude planner INSIDE the orchestrator instead: a long-lived stream-json
 * CLI participant whose publish_plan_fragment tool result carries the
 * Board's authoritative admission (graph version, dropped edges), and whose
 * open stdin lets awareness runners narrate execution back to it mid-plan.
 */

import { randomUUID } from "node:crypto"

import {
    BaseObserver,
    type AgenticEnvironment,
    type Participant,
    type SemanticEvent,
    type TokenUsage,
} from "../../runtime/mozaik.js"
import {
    AgentResult,
    type AgentResultData,
    ModelInvocationMeasured,
    PlanFragmentAdmitted,
    PlanFragmentRejected,
} from "../../semantic-events.js"
import type { ModelInvocationMeasuredData } from "../../telemetry/model-telemetry.js"
import { runnerMeasurement } from "../../telemetry/runner-measurement.js"
import {
    normalizeClaudeRunnerObservation,
    normalizeOpenAIRunnerObservation,
} from "../../conversation/dialogue-responder.js"
import { isNativeLane, laneAdapterFor } from "../../harness/lane-registry.js"
import type { CliHostFunctionBridge } from "../../harness/claude/lane-adapter.js"
import type { OpenAIConnection } from "../../harness/openai/runtime.js"
import { IdleWatchdog, llmIdleTimeoutMs } from "../../harness/liveness.js"
import type { PlanningFeed } from "../../execution/planning-feed.js"
import type { GoalEnvelope } from "../../conversation/session/conversation-contract.js"
import {
    PLANNER_SYSTEM_PROMPT,
    buildPlannerUserMessage,
    heuristicModeContract,
    type ModeContract,
} from "../domain/planner-prompts.js"
import {
    createPlannerHarnessProgressiveSupport,
    currentPlannerMcpServerCommand,
    PROGRESSIVE_PLANNER_MCP_SERVER_NAME,
    PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
    type PlannerMcpServerCommand,
} from "./planner-harness-progressive.js"
import {
    PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA,
    type PlannerOpenAIPlanFragmentEvent,
} from "./planner-openai-progressive.js"
import { extractJsonObject } from "../domain/planner-prompts.js"

export interface PlannerBusSessionOptions {
    runId: string
    cwd: string
    env: AgenticEnvironment
    feed: PlanningFeed
    goalEnvelope: GoalEnvelope
    /** Host-owned final-PRD metadata: the coordinator compares SEVEN fields
     * against the bootstrap contract (progressiveMetadataMatches), and the
     * model has no business restating any of them. */
    prdMetadata: {
        project: string
        branchName: string
        description: string
        conversationSessionId?: string
        goalEnvelope?: GoalEnvelope
        decisionDocument?: string
        executionMode?: unknown
    }
    decisionDocument?: string
    projectContext?: string
    modeContract?: ModeContract
    model?: string
    effort?: string
    claudeBin?: string
    /** Which lane holds the planner. Defaults to the CLI this began on. */
    backend?: string
    /** Endpoint for a lane that calls a model directly. */
    connection?: OpenAIConnection
    /** Route planner measurements through an already-trusted telemetry
     *  source (collective forwarders bind measurements to exact sources).
     *  Without it the session publishes them under its own identity. */
    publishMeasurement?: (data: ModelInvocationMeasuredData) => void
    /** Max silence before the planner is presumed hung. Activity on either
     *  stream resets it — a thinking planner is never killed. */
    idleTimeoutMs?: number
    /** Test override; defaults to this process entry serving the MCP mode. */
    mcpServer?: PlannerMcpServerCommand
    /** The Rust bootstrap PRD pre-seeds the planning latch with its own
     *  planningId; fragments must carry THAT id or the Board rejects them
     *  with planning_id_mismatch. When set, the session adopts it and skips
     *  its own planning_open. */
    existingPlanningId?: string
}

/** The planner's stable bus identity; awareness runners address this. */
export function plannerBusAgentId(runId: string): string {
    return `planner:${runId}`
}

interface FragmentReceipt {
    admitted: boolean
    graphVersion?: number
    storyIds?: readonly string[]
    droppedEdges?: readonly string[]
    replay?: boolean
    rejectionCode?: string
    rejectionReason?: string
}

/** Resolves fragment receipts by correlating admission events on the bus. */
class ReceiptObserver extends BaseObserver {
    private readonly waiters = new Map<
        string,
        (receipt: FragmentReceipt) => void
    >()

    constructor(private readonly planningId: string) {
        super()
    }

    await(fragmentId: string): Promise<FragmentReceipt> {
        return new Promise((resolve) => {
            this.waiters.set(fragmentId, resolve)
        })
    }

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (PlanFragmentAdmitted.is(event)) {
            if (event.data.planningId !== this.planningId) return
            this.settle(event.data.fragmentId, {
                admitted: true,
                graphVersion: event.data.graphVersion,
                storyIds: event.data.storyIds,
                droppedEdges: event.data.droppedEdges,
                replay: event.data.replay,
            })
            return
        }
        if (PlanFragmentRejected.is(event)) {
            if (event.data.planningId !== this.planningId) return
            if (!event.data.fragmentId) return
            this.settle(event.data.fragmentId, {
                admitted: false,
                rejectionCode: event.data.code,
                rejectionReason: event.data.reason,
            })
        }
    }

    private settle(fragmentId: string, receipt: FragmentReceipt): void {
        const waiter = this.waiters.get(fragmentId)
        if (!waiter) return
        this.waiters.delete(fragmentId)
        waiter(receipt)
    }
}

/** Hands each of the planner's terminal results to the session as it lands,
 *  so a rejected final PRD can be answered with a correction on the still-open
 *  stdin instead of killing the whole planning stream. */
class ResultStream extends BaseObserver {
    private readonly queue: string[] = []
    private waiter: ((text: string | null) => void) | null = null
    private closed = false

    constructor(private readonly agentId: string) {
        super()
    }

    /** Resolves with the next result text, or null once the agent is gone. */
    next(): Promise<string | null> {
        if (this.queue.length > 0) {
            return Promise.resolve(this.queue.shift()!)
        }
        if (this.closed) return Promise.resolve(null)
        return new Promise((resolve) => {
            this.waiter = resolve
        })
    }

    end(): void {
        this.closed = true
        if (this.waiter) {
            this.waiter(null)
            this.waiter = null
        }
    }

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (!AgentResult.is(event) || event.data.agentId !== this.agentId) {
            return
        }
        const text = event.data.isError ? null : event.data.resultText
        if (typeof text !== "string") return
        if (this.waiter) {
            this.waiter(text)
            this.waiter = null
        } else {
            this.queue.push(text)
        }
    }
}

/** Publishes one ModelInvocationMeasured per planner turn. The bus
 *  collector only admits story terminals with lease correlation, so the
 *  session is the runner-evidence producer for its own participant. */
class PlannerTelemetryObserver extends BaseObserver {
    private turn = 0

    constructor(
        private readonly runId: string,
        private readonly agentId: string,
        private readonly requestedModel: string,
        /** The lane that actually answered. Reporting every planner as Claude
         *  priced a DeepSeek turn on Anthropic's card and hid which model the
         *  run was measuring. */
        private readonly backend: string,
        private readonly publishMeasurement?: (
            data: ModelInvocationMeasuredData,
        ) => void,
    ) {
        super()
    }

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (!AgentResult.is(event) || event.data.agentId !== this.agentId) {
            return
        }
        const measurement = plannerTurnMeasurement({
            runId: this.runId,
            backend: this.backend,
            requestedModel: this.requestedModel,
            turn: ++this.turn,
            result: event.data,
        })
        if (this.publishMeasurement) {
            this.publishMeasurement(measurement)
            return
        }
        const measured = ModelInvocationMeasured.create(measurement)
        for (const env of this.getEnvironments()) {
            env.deliverSemanticEvent(this, measured)
        }
    }
}

/** Render the trusted envelope as the planner's goal statement. */
export function goalTextFromEnvelope(envelope: GoalEnvelope): string {
    const section = (title: string, items: readonly string[]): string =>
        items.length > 0 ? `\n\n${title}:\n${items.map((i) => `- ${i}`).join("\n")}` : ""
    return (
        envelope.objective +
        section("Constraints", envelope.constraints) +
        section("Acceptance criteria", envelope.acceptanceCriteria) +
        section("Non-goals", envelope.nonGoals) +
        section("Assumptions", envelope.assumptions)
    )
}

export interface PlannerBusSessionResult {
    status: "completed" | "failed"
    reason?: string
}

/**
 * Run one planner session on the bus. Resolves when planning has completed
 * or failed; fragment admission and final reconciliation flow through the
 * same PlanningFeed authority the stdin lane uses, so the Board's validation
 * path is identical in both modes.
 */
export async function runPlannerBusSession(
    opts: PlannerBusSessionOptions,
): Promise<PlannerBusSessionResult> {
    const planningId =
        opts.existingPlanningId ?? `planning-bus-${randomUUID().slice(0, 13)}`
    const agentId = plannerBusAgentId(opts.runId)
    const goal = goalTextFromEnvelope(opts.goalEnvelope)
    const modeContract =
        opts.modeContract ??
        heuristicModeContract({
            goal,
            decisionDocument: opts.decisionDocument,
        })

    if (!opts.existingPlanningId) {
        opts.feed.open({
            type: "planning_open",
            run_id: opts.runId,
            planning_id: planningId,
        })
    }

    const fail = (code: string, reason: string): PlannerBusSessionResult => {
        opts.feed.failed({
            type: "plan_failed",
            run_id: opts.runId,
            planning_id: planningId,
            code,
            reason,
        })
        return { status: "failed", reason: `${code}: ${reason}` }
    }

    const receipts = new ReceiptObserver(planningId)
    receipts.join(opts.env)

    let progressive: Awaited<
        ReturnType<typeof createPlannerHarnessProgressiveSupport>
    >
    try {
        progressive = await createPlannerHarnessProgressiveSupport({
            runId: opts.runId,
            planningId,
            trustedGoalEnvelope: opts.goalEnvelope,
            trustedDecisionDocument: opts.decisionDocument,
            // The host holds the admitted prefix; the model finalizes with
            // only the appended tail and the host composes the full plan.
            finalizationTailOnly: true,
            mcpServer: opts.mcpServer ?? currentPlannerMcpServerCommand(),
            publish: async (event: PlannerOpenAIPlanFragmentEvent) => {
                const receipt = receipts.await(event.fragment_id)
                opts.feed.fragment(event)
                const outcome = await receipt
                if (!outcome.admitted) {
                    throw new Error(
                        `fragment rejected (${outcome.rejectionCode}): ${outcome.rejectionReason}`,
                    )
                }
                return {
                    graphVersion: outcome.graphVersion,
                    admittedStoryIds: outcome.storyIds,
                    replayed: outcome.replay === true,
                    ...(outcome.droppedEdges && outcome.droppedEdges.length > 0
                        ? {
                              droppedEdges: outcome.droppedEdges,
                              droppedEdgeNote:
                                  "these dependsOn edges had no supporting file " +
                                  "and were pruned by the host on admission",
                          }
                        : {}),
                }
            },
        })
    } catch (error) {
        receipts.leave(opts.env)
        return fail(
            "planner_failed",
            error instanceof Error ? error.message : String(error),
        )
    }

    const systemPrompt = progressive.systemInstruction
        ? `${PLANNER_SYSTEM_PROMPT}\n\n${progressive.systemInstruction}`
        : PLANNER_SYSTEM_PROMPT
    const progressiveTool =
        `mcp__${PROGRESSIVE_PLANNER_MCP_SERVER_NAME}__${PROGRESSIVE_PLANNER_MCP_TOOL_NAME}`

    // The relay this session already owns, stated as what a process-bound lane
    // needs: the CLI is pointed at a server, and this is the only place that
    // knows a server was ever involved.
    const bridge: CliHostFunctionBridge = {
        expose: async () => {
            // Asking is what opens it: a lane in this loop never does, so no
            // socket is bound and nothing unused can fail the run.
            const mcp = await progressive.openMcpConnection()
            return {
                cliExtraArgs: [
                    "--mcp-config",
                    JSON.stringify({
                        mcpServers: {
                            [PROGRESSIVE_PLANNER_MCP_SERVER_NAME]: {
                                type: "stdio",
                                command: mcp.command,
                                args: mcp.args,
                                // Claude expands ${VAR} from its own
                                // environment, so the relay secret never
                                // enters argv.
                                env: Object.fromEntries(
                                    Object.keys(mcp.providerEnvironment).map(
                                        (name) => [name, `\${${name}}`],
                                    ),
                                ),
                            },
                        },
                    }),
                    "--allowed-tools",
                    progressiveTool,
                ],
                close: async () => {},
            }
        },
    }

    // Deterministic default: without it the CLI silently picks the user's
    // account default and the run's planner model varies per machine.
    const requestedModel = opts.model ?? "opus"
    const lane = laneAdapterFor({
        backend: opts.backend ?? "claude",
        ...(opts.connection ? { connection: opts.connection } : {}),
        ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
        hostFunctionBridge: bridge,
    })
    // What the planner needs, in the only terms that mean the same thing on
    // every lane: read the repository, and call the one function that admits
    // a fragment. Whether that costs a spawned server is the lane's business.
    let grant
    try {
        grant = await lane.grant([
            { kind: "read-repo", cwd: opts.cwd },
            {
                kind: "host-function",
                fn: {
                    name: PROGRESSIVE_PLANNER_MCP_TOOL_NAME,
                    description:
                        "Publish a plan fragment and receive the host's admission receipt.",
                    parameters: PUBLISH_PLAN_FRAGMENT_INPUT_SCHEMA,
                    invoke: (args) => progressive.publish(args),
                },
            },
        ])
    } catch (error) {
        receipts.leave(opts.env)
        await progressive.close()
        return fail(
            "planner_failed",
            error instanceof Error ? error.message : String(error),
        )
    }
    const planner = lane.create(
        {
            agentId,
            cwd: opts.cwd,
            model: requestedModel,
            ...(opts.effort ? { effort: opts.effort } : {}),
            systemPrompt,
        },
        grant,
    )

    // Only a lane that spawns a process needs the relay secret in the
    // environment it will inherit; a planner in this loop never sees one.
    const previousEnv: Record<string, string | undefined> = {}
    for (const [name, value] of Object.entries(
        progressive.mcpConnection?.providerEnvironment ?? {},
    )) {
        previousEnv[name] = process.env[name]
        process.env[name] = value
    }

    const results = new ResultStream(agentId)
    const telemetry = new PlannerTelemetryObserver(
        opts.runId,
        agentId,
        requestedModel,
        opts.backend ?? "claude",
        opts.publishMeasurement,
    )
    let watchdog: IdleWatchdog | null = null
    try {
        results.join(opts.env)
        telemetry.join(opts.env)
        planner.join(opts.env)
        planner.start(opts.env)
        watchdog = new IdleWatchdog(
            opts.idleTimeoutMs ?? llmIdleTimeoutMs(),
            () => {
                results.end()
                void planner.abortAndWait()
            },
        )
        planner.onActivity = () => watchdog?.pet()
        void planner.done.then(() => results.end())
        planner.sendUserMessage(
            buildPlannerUserMessage({
                goal,
                decisionDocument: opts.decisionDocument,
                projectContext: opts.projectContext,
                modeContract,
            }),
        )

        // Run 13 died here the old way: one verbatim mismatch in the final
        // PRD closed the whole stream. The planner's stdin is open — a
        // rejected finalization is something it can be TOLD, so it gets the
        // error back as a message and another turn to restate.
        const maxFinalizationAttempts = 3
        for (let attempt = 1; attempt <= maxFinalizationAttempts; attempt++) {
            const resultText = await results.next()
            if (resultText === null) {
                await planner.done.catch(() => undefined)
                return fail(
                    "planner_failed",
                    `planner produced no result: ${planner.sessionEndDetail()}`,
                )
            }
            let composedFinalPrd: Record<string, unknown>
            let candidate: string | null = null
            try {
                candidate = extractJsonObject(resultText.trim())
            } catch {
                candidate = null
            }
            try {
                if (candidate === null) {
                    throw new Error(
                        `no valid JSON object in response: ${resultText.trim().slice(0, 200)}`,
                    )
                }
                progressive.assertInitialized()
                composedFinalPrd = progressive.reconcileFinalCandidate(candidate)
            } catch (error) {
                let reason =
                    error instanceof Error ? error.message : String(error)
                // The MCP child is spawned by the lane's CLI, not by us: the
                // relay only knows whether anyone connected. Saying "not
                // initialized" and nothing else sent one diagnosis looking
                // through four correct links before asking the one process
                // that saw the failure. Whatever the lane reported goes with it.
                if (/was not initialized by the harness/.test(reason)) {
                    const detail = planner.sessionEndDetail()
                    if (detail) reason = `${reason} — the lane reported: ${detail}`
                }
                process.stderr.write(
                    `[planner-bus] finalization attempt ${attempt}/${maxFinalizationAttempts} rejected: ${reason}\n`,
                )
                if (attempt < maxFinalizationAttempts) {
                    planner.sendUserMessage(
                        `Your final PRD was rejected: ${reason}\n\n` +
                            `The host already holds every published story verbatim — do not ` +
                            `repeat them. Reply with ONLY the corrected final PRD JSON whose ` +
                            `userStories contains just the stories that come after the ` +
                            `published prefix (an empty array if nothing remains), plus the ` +
                            `usual project, branchName and description metadata.`,
                    )
                    continue
                }
                planner.closeStdin()
                // The host already holds every admitted story — the run is
                // not missing a plan, only the planner's restatement of
                // "nothing remains" in the terminal shape. Compose that shape
                // here; reconciliation and obligation coverage still judge
                // it, so a prefix that does not cover the goal contract
                // fails exactly as before. Composition covers ONLY the
                // shapeless-prose case: a candidate that PARSED and was
                // rejected carries planner intent this host must not
                // silently overrule.
                if (candidate !== null || !progressive.hasEarlyPlan()) {
                    return fail("planner_failed", reason)
                }
                try {
                    composedFinalPrd = progressive.reconcileFinalCandidate(
                        JSON.stringify({
                            project: opts.prdMetadata.project,
                            branchName: opts.prdMetadata.branchName,
                            description: opts.prdMetadata.description,
                            userStories: [],
                        }),
                    )
                } catch (composeError) {
                    return fail(
                        "planner_failed",
                        `${reason}; host empty-tail composition also failed: ${
                            composeError instanceof Error
                                ? composeError.message
                                : String(composeError)
                        }`,
                    )
                }
                process.stderr.write(
                    "[planner-bus] terminal restatement never arrived — " +
                        "host composed the published prefix with an empty tail\n",
                )
            }
            planner.closeStdin()
            await planner.done
            opts.feed.complete({
                type: "plan_complete",
                run_id: opts.runId,
                planning_id: planningId,
                // Host metadata + host-composed stories: the model's own
                // metadata restatement killed run 16 at the bootstrap check.
                final_prd: {
                    ...opts.prdMetadata,
                    userStories: composedFinalPrd.userStories,
                },
            })
            return { status: "completed" }
        }
        return fail("planner_failed", "finalization attempts exhausted")
    } catch (error) {
        // Whatever went wrong, the open planning stream must be closed —
        // an orphaned latch would stall the Board forever.
        return fail(
            "planner_failed",
            error instanceof Error ? error.message : String(error),
        )
    } finally {
        watchdog?.dispose()
        results.end()
        receipts.leave(opts.env)
        results.leave(opts.env)
        telemetry.leave(opts.env)
        if (planner.getEnvironments().includes(opts.env)) {
            planner.leave(opts.env)
        }
        await progressive.close()
        for (const [name, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    }
}

/**
 * One planner turn as a runner measurement.
 *
 * Which lane answered decides how the usage is read AND how it is priced: the
 * Claude wrapper reports its own totals and cost, a native turn reports the
 * accumulator's sum of its rounds. Labelling every planner "claude" priced a
 * DeepSeek turn on Anthropic's card.
 */
export function plannerTurnMeasurement(input: {
    runId: string
    backend: string
    requestedModel: string
    turn: number
    result: AgentResultData
}): ModelInvocationMeasuredData {
    const { runId, backend, requestedModel, turn, result } = input
    const observation = isNativeLane(backend)
        ? normalizeOpenAIRunnerObservation(
              nativeTurnUsage(result.usage),
              requestedModel,
              true,
          )
        : normalizeClaudeRunnerObservation(
              {
                  usage: result.usage ?? undefined,
                  modelUsage: result.modelUsage ?? undefined,
                  duration_ms: result.durationMs ?? undefined,
                  total_cost_usd: result.totalCostUsd ?? undefined,
              },
              requestedModel,
          )
    return runnerMeasurement(
        {
            invocationBaseId: `${runId}:planner:${turn}`,
            runId,
            phase: "planner",
            storyId: null,
            turn,
            backend,
            requestedModel,
        },
        {
            ...observation,
            // A native turn is the sum of its rounds, not one round.
            ...(isNativeLane(backend) ? { granularity: "turn" as const } : {}),
            status: result.isError ? "failed" : "succeeded",
        },
    )
}

/**
 * The native lane reports a turn as its rounds summed, in the accumulator's
 * snake_case; the shared normalizer reads Mozaik's shape.
 */
function nativeTurnUsage(
    usage: Readonly<Record<string, unknown>> | null,
): TokenUsage | undefined {
    if (!usage) return undefined
    const count = (key: string): number | undefined =>
        typeof usage[key] === "number" ? (usage[key] as number) : undefined
    return {
        inputTokens: count("input_tokens") ?? 0,
        outputTokens: count("output_tokens") ?? 0,
        totalTokens: count("total_tokens") ?? 0,
        inputTokenDetails: { cached_tokens: count("cached_input_tokens") },
        outputTokenDetails: { reasoning_tokens: count("reasoning_tokens") },
    } as unknown as TokenUsage
}
