/**
 * An attempt that died before reporting was never judged, so its commits may
 * already be the answer (#180: S3's green fix stranded after two infra kills).
 * The host re-runs the story's gate on them before spending another agent.
 */

import {
    AgenticEnvironment,
    BaseObserver,
    FunctionCallItem,
    FunctionCallOutputItem,
} from "../runtime/mozaik.js"
import { AgentResult, AgentState, StoryResult } from "../semantic-events.js"
import type { StorySpawnRequestData } from "../semantic-events.js"
import { gateCommandWasKilled } from "../verification/continuous-gate-runner.js"
import {
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

export interface CommitGateOptions {
    readonly plan?: VerifyPlan
    readonly hostRepoRoot?: string
    readonly signal?: AbortSignal
}

/** Null when nothing ran or a command was cut short: neither says anything
 * about the commit, so neither may stand in for an agent attempt. */
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
export class ReverifiedCommit extends BaseObserver {
    constructor(private readonly spec: ReverifiedCommitSpec) {
        super()
    }

    get agentId(): string {
        return this.spec.storyId
    }

    run(env: AgenticEnvironment): void {
        const startedAt = Date.now()
        const { storyId, head, gate } = this.spec
        const short = head.slice(0, 12)
        // "attempt " starts a fresh evidence window in the Critic's collector.
        env.deliverSemanticEvent(
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
        env.deliverFunctionCall(
            this,
            FunctionCallItem.rehydrate({
                callId,
                name: "Bash",
                args: JSON.stringify({
                    command: gate.map(({ command }) => command).join(" && "),
                }),
            }),
        )
        env.deliverFunctionCallOutput(
            this,
            FunctionCallOutputItem.create(
                callId,
                gate.map(({ command, output }) => `$ ${command}\n${output}`).join("\n\n"),
            ),
        )
        const durationMs = Date.now() - startedAt
        env.deliverSemanticEvent(
            this,
            AgentResult.create({
                agentId: storyId,
                terminalId: `reverify:${this.spec.leaseId ?? storyId}:${head}`,
                subtype: "success",
                sessionId: null,
                isError: false,
                resultText: [
                    `The previous attempt ended before it could report, after committing ${short}.`,
                    "No agent ran in this attempt: the host restored that commit onto the latest run branch and re-ran the story's gate on it.",
                    ...gate.map(({ command }) => `  PASS  ${command}`),
                    "Judge the committed change against the story's acceptance criteria.",
                ].join("\n"),
                usage: null,
                totalCostUsd: null,
                numTurns: null,
                durationMs,
            }),
        )
        env.deliverSemanticEvent(
            this,
            AgentState.create({
                agentId: storyId,
                phase: "done",
                detail: `re-verified committed ${short}`,
            }),
        )
        env.deliverSemanticEvent(
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
        env: AgenticEnvironment,
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
