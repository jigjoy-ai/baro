/**
 * An attempt that died before reporting was never judged, so its commits may
 * already be the answer (#180: S3's green fix stranded after two infra kills).
 * The host re-runs the story's gate on them before spending another agent.
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
} from "../runtime/mozaik.js"
import { BusMember, CoordinationBus } from "../runtime/coordination.js"
import { AgentResult, AgentState, StoryResult } from "../semantic-events.js"
import type { StorySpawnRequestData } from "../semantic-events.js"
import { gateCommandWasKilled } from "../verification/continuous-gate-runner.js"
import { readAuthoritativeVerifyPlanOptions } from "../verification/prd-declared-tests.js"
import {
    createVerifyPlan,
    isRunLevelCommand,
    mergeVerifyPlans,
    verifyBuild,
    type VerifyCommandResult,
    type VerifyPlan,
} from "../verification/verify.js"
import type { StoryExecOpts, StoryExecution, StoryExecutor } from "./story-executor.js"

export interface ReverifiedGateCommand {
    readonly command: string
    readonly passed: boolean
    /** Bounded real output, kept for passing commands too: it is Critic evidence. */
    readonly output: string
}

export type CommitGate = (
    storyId: string,
    cwd: string,
    signal: AbortSignal,
) => Promise<readonly ReverifiedGateCommand[] | null>

export interface StoryCommitGateOptions {
    /** Snapshotted before any agent ran, so a story cannot delete a gate. */
    readonly basePlan: VerifyPlan
    /** Where basePlan was built; the story plan must share its command identities. */
    readonly planRoot: string
    readonly prdPath: string
    readonly hostRepoRoot?: string
    /** The continuous gate's queue, so this is never a concurrent full test run. */
    readonly exclusive?: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>
}

/**
 * The project's gate plus the story's own declared tests. A story that
 * declares none gets no verdict: a green existing suite says nothing about
 * whether an attempt that died partway finished the story.
 */
export function storyCommitGate(opts: StoryCommitGateOptions): CommitGate {
    return async (storyId, cwd, signal) => {
        const plan = storyGatePlan(opts, storyId)
        if (!plan) return null
        const run = (queueSignal?: AbortSignal) =>
            runCommitGate(cwd, {
                plan,
                ...(opts.hostRepoRoot ? { hostRepoRoot: opts.hostRepoRoot } : {}),
                signal: queueSignal ? AbortSignal.any([signal, queueSignal]) : signal,
            })
        if (!opts.exclusive) return run()
        return opts.exclusive((queueSignal) =>
            signal.aborted ? Promise.resolve(null) : run(queueSignal),
        )
    }
}

function storyGatePlan(opts: StoryCommitGateOptions, storyId: string): VerifyPlan | null {
    const { declaredTests, testBudgets } = readAuthoritativeVerifyPlanOptions(opts.prdPath)
    const own = declaredTests.filter((test) => test.storyId === storyId)
    if (own.length === 0) return null
    return mergeVerifyPlans(
        opts.basePlan,
        createVerifyPlan(opts.planRoot, {
            declaredTests: own,
            testBudgets: testBudgets.filter((budget) => budget.storyId === storyId),
        }),
    )
}

export interface CommitGateOptions {
    readonly plan?: VerifyPlan
    readonly hostRepoRoot?: string
    readonly signal?: AbortSignal
}

/** Null when nothing ran, a command was cut short or a story test could not
 * run: none says anything about the commit, so none may stand in for an
 * agent attempt. */
export async function runCommitGate(
    cwd: string,
    opts: CommitGateOptions = {},
): Promise<readonly ReverifiedGateCommand[] | null> {
    const result = await verifyBuild(cwd, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.plan ? { plan: opts.plan } : {}),
        ...(opts.hostRepoRoot ? { hostRepoRoot: opts.hostRepoRoot } : {}),
    })
    if (result.commands.some(gateCommandWasKilled)) return null
    const declared = new Set(
        (opts.plan?.commands ?? [])
            .filter((command) => !isRunLevelCommand(command))
            .map(({ label }) => label),
    )
    if (result.commands.some(({ command, status }) => status === "skipped" && declared.has(command))) {
        return null
    }
    const commands = result.commands
        .filter((command) => command.status !== "skipped")
        .map((command) => ({
            command: command.command,
            passed: command.status === "passed",
            output: renderOutput(command),
        }))
    return commands.length > 0 ? commands : null
}

export function commitGatePassed(
    gate: readonly ReverifiedGateCommand[] | null,
): gate is readonly ReverifiedGateCommand[] {
    return gate !== null && gate.length > 0 && gate.every(({ passed }) => passed)
}

function renderOutput(command: VerifyCommandResult): string {
    const streams = [command.output?.stdout, command.output?.stderr]
        .filter((stream): stream is string => Boolean(stream?.trim()))
    const body = streams.length > 0 ? streams.join("\n") : command.tail ?? ""
    const seconds = Math.round(command.durationMs / 1000)
    return `[host gate: ${command.status} in ${seconds}s]\n${body}`.trimEnd()
}

export interface ReverifiedCommitSpec {
    readonly storyId: string
    readonly head: string
    readonly gate: readonly ReverifiedGateCommand[]
    readonly runId?: string
    readonly leaseId?: string
    readonly generation?: number
}

/**
 * Speaks for the story in place of an agent: the host's gate commands become
 * the attempt's command evidence and a terminal turn describes the commit, so
 * a Critic can still reject it and send the story to ordinary recovery.
 */
export class ReverifiedCommit extends BusMember {
    constructor(private readonly spec: ReverifiedCommitSpec) {
        super()
    }

    get agentId(): string {
        return this.spec.storyId
    }

    run(env: CoordinationBus): void {
        const startedAt = Date.now()
        const { storyId, head, gate } = this.spec
        const short = head.slice(0, 12)
        // "attempt " starts a fresh evidence window in the Critic's collector.
        env.publish(
            this,
            AgentState.create({
                agentId: storyId,
                phase: "running",
                detail: `attempt reverify: host gate on committed ${short}`,
            }),
        )
        // One call: the evidence collector marks a command unverifiable when
        // another shell call lands while its fingerprint is being captured.
        const callId = `reverify:${this.spec.leaseId ?? storyId}:${head}`
        env.publishFunctionCall(
            this,
            FunctionCallItem.rehydrate({
                callId,
                name: "Bash",
                args: JSON.stringify({
                    command: gate.map(({ command }) => command).join(" && "),
                }),
            }),
        )
        env.publishFunctionCallOutput(
            this,
            FunctionCallOutputItem.create(
                callId,
                gate.map(({ command, output }) => `$ ${command}\n${output}`).join("\n\n"),
            ),
        )
        const durationMs = Date.now() - startedAt
        env.publish(
            this,
            AgentResult.create({
                agentId: storyId,
                terminalId: `reverify:${this.spec.leaseId ?? storyId}:${head}`,
                subtype: "success",
                sessionId: null,
                isError: false,
                // No PASS lines: the command evidence already carries the
                // output, and a verdict-shaped summary invites a rubber stamp.
                resultText: [
                    `The previous attempt ended before it could report, after committing ${short}; it may have stopped partway.`,
                    "No agent ran in this attempt and nobody claims the story is done: the host restored that commit onto the latest run branch and re-ran the story's gate on it.",
                    "A green gate does not show the change is complete. Judge the committed change against every acceptance criterion.",
                ].join("\n"),
                usage: null,
                totalCostUsd: null,
                numTurns: null,
                durationMs,
            }),
        )
        env.publish(
            this,
            AgentState.create({
                agentId: storyId,
                phase: "done",
                detail: `re-verified committed ${short}`,
            }),
        )
        env.publish(
            this,
            StoryResult.create({
                storyId,
                success: true,
                attempts: 0,
                durationSecs: Math.round(durationMs / 1000),
                error: null,
                ...(this.spec.runId !== undefined ? { runId: this.spec.runId } : {}),
                ...(this.spec.leaseId !== undefined ? { leaseId: this.spec.leaseId } : {}),
                ...(this.spec.generation !== undefined
                    ? { generation: this.spec.generation }
                    : {}),
            }),
        )
    }
}

/** Executor seam for one re-verified spawn, so StoryFactory's authority
 * registration and lifecycle bookkeeping stay identical to an agent's. */
export class ReverifiedCommitExecutor implements StoryExecutor {
    constructor(
        private readonly head: string,
        private readonly gate: readonly ReverifiedGateCommand[],
    ) {}

    start(
        req: StorySpawnRequestData,
        _route: unknown,
        _cwd: string,
        env: CoordinationBus,
        opts: StoryExecOpts,
    ): StoryExecution {
        const participant = new ReverifiedCommit({
            storyId: req.storyId,
            head: this.head,
            gate: this.gate,
            ...(req.runId !== undefined ? { runId: req.runId } : {}),
            ...(req.leaseId !== undefined ? { leaseId: req.leaseId } : {}),
            ...(req.generation !== undefined ? { generation: req.generation } : {}),
        })
        opts.registerResultAuthority?.(participant)
        participant.join(env)
        // Deferred so StoryFactory records the execution before its result lands.
        queueMicrotask(() => participant.run(env))
        return { dispose: (e) => participant.leave(e) }
    }
}
