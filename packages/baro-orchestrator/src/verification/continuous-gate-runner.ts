/**
 * Runs a story's own gates in its worktree while its agent is still working,
 * and reports the result to that agent.
 *
 * The measured problem: 45% of story time is spent after the last file write,
 * and it is spent running `go build`, `go test`, `vet` and `git status` — a
 * model round trip apiece. The host runs those same commands anyway, for
 * Critic evidence and for the final verifier. Running them once more, cheaply
 * and deterministically, and handing the answer over turns three of the
 * agent's turns into none.
 *
 * Deliberately provider-neutral: it observes tool calls on the bus and
 * answers with a targeted message, so a subprocess agent (Claude Code, over
 * its open stdin session) and an in-process one (the gateway lane) are served
 * by the same code. No model is ever called from here.
 */

import type { FunctionCallItem, Participant, SemanticEvent } from "../runtime/mozaik.js"
import { AgentTargetedMessage } from "../events/collaboration.js"
import { BaseObserver } from "../runtime/mozaik.js"
import { participantAgentId } from "../runtime/participant-identity.js"
import {
    renderGateReport,
    shouldDeliverGate,
    summarizeGate,
    type GateCommandOutcome,
    type GateOutcome,
} from "./continuous-gate.js"
import { verifyBuild, type VerifyPlan } from "./verify.js"

export interface ContinuousGateTarget {
    /** The story's own worktree; gates must never run in the shared checkout. */
    readonly cwd: string
}

export interface ContinuousGateRunnerOptions {
    readonly runId: string
    /** Same port the Critic uses to find a story's worktree. */
    resolveTarget(agentId: string): ContinuousGateTarget | null
    /** Snapshotted before agents mutate the repo, exactly as RunVerifier uses it. */
    readonly plan?: VerifyPlan
    /**
     * Quiet period after a write before gates run. A story writes several
     * files in a row; checking after each one would burn the machine the
     * agents are competing for.
     */
    readonly settleMs?: number
    /** Escape hatch for tests; production runs the real commands. */
    runGates?(cwd: string, plan: VerifyPlan | undefined, signal: AbortSignal):
        Promise<readonly GateCommandOutcome[]>
}

const DEFAULT_SETTLE_MS = 4_000

function isWriteTool(name: string): boolean {
    return [
        "write",
        "write_file",
        "edit",
        "edit_file",
        "multiedit",
        "multi_edit",
        "apply_patch",
        "patch",
    ].includes(name.trim().toLowerCase())
}

export class ContinuousGateRunner extends BaseObserver {
    private readonly lastDelivered = new Map<string, GateOutcome>()
    private readonly timers = new Map<string, NodeJS.Timeout>()
    private readonly running = new Set<string>()
    private readonly dirtyWhileRunning = new Set<string>()
    private readonly controller = new AbortController()
    private readonly noted = new Set<string>()
    private stopped = false

    constructor(private readonly opts: ContinuousGateRunnerOptions) {
        super()
    }

    override onExternalFunctionCall(source: Participant, item: FunctionCallItem): void {
        if (this.stopped) return
        if (!isWriteTool(item.name)) return
        const agentId = participantAgentId(source)
        if (!agentId) {
            this.note("saw a write from a participant with no agent id")
            return
        }
        this.schedule(agentId)
    }

    /** One line per distinct condition; enough to tell silence from absence. */
    private note(message: string): void {
        if (this.noted.has(message)) return
        this.noted.add(message)
        process.stderr.write(`[continuous-gate] ${message}\n`)
    }

    /** Stops timers and cancels a running gate; safe to call more than once. */
    stop(): void {
        this.stopped = true
        for (const timer of this.timers.values()) clearTimeout(timer)
        this.timers.clear()
        this.controller.abort()
    }

    private schedule(agentId: string): void {
        if (this.running.has(agentId)) {
            // A write landed mid-check: whatever we are about to report is
            // already stale, so queue exactly one more pass rather than
            // racing a second command set through the same worktree.
            this.dirtyWhileRunning.add(agentId)
            return
        }
        const existing = this.timers.get(agentId)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
            this.timers.delete(agentId)
            void this.run(agentId)
        }, this.opts.settleMs ?? DEFAULT_SETTLE_MS)
        timer.unref?.()
        this.timers.set(agentId, timer)
    }

    private async run(agentId: string): Promise<void> {
        if (this.stopped) return
        const target = this.opts.resolveTarget(agentId)
        if (!target) {
            this.note(`no worktree resolved for ${agentId}`)
            return
        }
        this.running.add(agentId)
        try {
            const commands = await this.execute(target.cwd)
            if (this.stopped) return
            const outcome = summarizeGate(commands)
            if (shouldDeliverGate(this.lastDelivered.get(agentId) ?? null, outcome)) {
                this.lastDelivered.set(agentId, outcome)
                this.deliver(agentId, outcome)
                this.note("delivering gate results to agents")
            }
        } catch (error) {
            // A gate that cannot run is the host's problem, not the agent's.
            // Staying silent leaves the agent exactly where it was; telling it
            // about our own failure would only cost it a turn — but the
            // operator still needs to know we tried and could not.
            this.note(`gates failed to run: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            this.running.delete(agentId)
            if (this.dirtyWhileRunning.delete(agentId)) this.schedule(agentId)
        }
    }

    private async execute(cwd: string): Promise<readonly GateCommandOutcome[]> {
        if (this.opts.runGates) {
            return await this.opts.runGates(cwd, this.opts.plan, this.controller.signal)
        }
        const result = await verifyBuild(cwd, {
            signal: this.controller.signal,
            ...(this.opts.plan ? { plan: this.opts.plan } : {}),
        })
        return result.commands.map((command) => ({
            label: command.command,
            passed: command.status === "passed",
            detail: command.status === "passed" ? "" : command.tail ?? "",
        }))
    }

    private deliver(agentId: string, outcome: GateOutcome): void {
        const event = AgentTargetedMessage.create({
            recipientId: agentId,
            text: renderGateReport(outcome),
            metadata: { source: "continuous-gate", runId: this.opts.runId },
        })
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, event as SemanticEvent<unknown>)
        }
    }
}
