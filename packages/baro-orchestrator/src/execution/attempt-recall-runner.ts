/**
 * Hands a restarted story what its killed predecessor had already worked out.
 *
 * Everything here is observed from the bus — assistant text, tool calls, their
 * outcomes — so nothing depends on an agent choosing to report before it dies.
 * That choice is exactly what a SIGKILL takes away.
 */

import type {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    SemanticEvent,
} from "../runtime/mozaik.js"
import { toWire } from "../runtime/mozaik.js"
import { AgentTargetedMessage } from "../events/collaboration.js"
import { BusMember } from "../runtime/coordination.js"
import { StoryResult, WorkLeaseGranted } from "../semantic-events.js"
import {
    filePathFromToolCall,
    isFileMutationTool,
    isShellTool,
} from "../harness/tool-classification.js"
import { participantAgentId } from "../runtime/participant-identity.js"
import { repositoryRelativePath } from "../runtime/worktree-path.js"
import {
    type AttemptRecord,
    emptyAttempt,
    recallForRetry,
    withCommand,
    withStatement,
    withWrite,
} from "./attempt-recall.js"

export interface AttemptRecallRunnerOptions {
    readonly runId: string
    /** Only this participant's lease grants start a new attempt. */
    readonly leaseAuthority?: BusMember
    /** Repository root per story, so a path means the same thing after restart. */
    resolveRoot?(agentId: string): string | null
}

export class AttemptRecallRunner extends BusMember {
    /** What the attempt currently running for this story has established. */
    private readonly live = new Map<string, AttemptRecord>()
    /** Frozen at the moment an attempt died, waiting for its successor. */
    private readonly inherited = new Map<string, AttemptRecord>()
    /** Call id → agent, so an output can be attributed to the call it answers. */
    private readonly pending = new Map<string, { agentId: string; command: string }>()

    constructor(private readonly opts: AttemptRecallRunnerOptions) {
        super()
    }

    override onExternalModelMessage(source: BusMember, item: ModelMessageItem): void {
        this.guard(() => {
            const agentId = participantAgentId(source)
            if (!agentId) return
            const json = toWire(item) as { content?: Array<{ text?: string }> }
            const text = (json.content ?? [])
                .map((part) => part.text ?? "")
                .filter(Boolean)
                .join(" ")
            if (!text.trim()) return
            this.live.set(agentId, withStatement(this.recordFor(agentId), text))
        })
    }

    override onExternalFunctionCall(source: BusMember, item: FunctionCallItem): void {
        this.guard(() => {
            const agentId = participantAgentId(source)
            if (!agentId) return
            if (isFileMutationTool(item.name)) {
                const path = filePathFromToolCall(item.args)
                if (path) {
                    this.live.set(
                        agentId,
                        withWrite(this.recordFor(agentId), this.relative(agentId, path)),
                    )
                }
                return
            }
            if (!isShellTool(item.name)) return
            const command = shellCommandOf(item.args)
            if (command) this.pending.set(item.callId, { agentId, command })
        })
    }

    override onExternalFunctionCallOutput(
        _source: BusMember,
        item: FunctionCallOutputItem,
    ): void {
        this.guard(() => {
            const call = this.pending.get(item.callId)
            if (!call) return
            this.pending.delete(item.callId)
            const output = String((item as { output?: unknown }).output ?? "")
            this.live.set(
                call.agentId,
                withCommand(
                    this.recordFor(call.agentId),
                    call.command,
                    /exit code [1-9]|command failed|error:/iu.test(output),
                ),
            )
        })
    }

    override onExternalEvent(source: BusMember, event: SemanticEvent<string, unknown>): void {
        this.guard(() => this.react(source, event))
    }

    private react(source: BusMember, event: SemanticEvent<string, unknown>): void {
        if (StoryResult.is(event) && event.payload.runId === this.opts.runId) {
            const storyId = event.payload.storyId
            const record = this.live.get(storyId)
            this.live.delete(storyId)
            // A story that reported — pass or fail — was judged on its work, and
            // its successor is a different attempt at a re-scoped problem. Only
            // an attempt that never got to report has something unfinished to
            // hand over.
            if (record && !event.payload.success && wasKilled(event.payload)) {
                this.inherited.set(storyId, record)
            }
            return
        }
        if (!WorkLeaseGranted.is(event)) return
        if (event.payload.runId !== this.opts.runId) return
        if (this.opts.leaseAuthority && source !== this.opts.leaseAuthority) return
        const storyId = event.payload.request?.storyId
        if (!storyId) return
        const record = this.inherited.get(storyId)
        if (!record) return
        this.inherited.delete(storyId)
        const text = recallForRetry(record)
        if (text) this.deliver(storyId, text)
    }

    private recordFor(agentId: string): AttemptRecord {
        return this.live.get(agentId) ?? emptyAttempt()
    }

    private relative(agentId: string, path: string): string {
        return repositoryRelativePath(this.opts.resolveRoot?.(agentId) ?? null, path)
    }

    private deliver(recipientId: string, text: string): void {
        const message = AgentTargetedMessage.create({
            recipientId,
            text,
            metadata: { source: "attempt-recall", runId: this.opts.runId },
        })
        for (const environment of this.getBuses()) {
            environment.publish(this, message as SemanticEvent<string, unknown>)
        }
    }

    /** mozaik 3.12 delivers with `void this.react(...)`; a throw here kills the run. */
    private guard(work: () => void): void {
        try {
            work()
        } catch (error) {
            process.stderr.write(
                `[attempt-recall] ignored a malformed item: ${error instanceof Error ? error.message : String(error)}\n`,
            )
        }
    }
}

/** The failure lane that means "nobody judged this work". */
function wasKilled(data: { failure?: { kind?: string; code?: string } }): boolean {
    return (
        data.failure?.kind === "infrastructure" &&
        data.failure.code === "process_killed"
    )
}

function shellCommandOf(args: string): string | null {
    try {
        const parsed = JSON.parse(args) as { command?: unknown }
        return typeof parsed.command === "string" ? parsed.command : null
    } catch {
        return null
    }
}
