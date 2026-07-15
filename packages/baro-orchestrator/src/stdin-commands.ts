/**
 * TUI→orchestrator stdin command dispatch. Additive channel: commands
 * arriving before the bus is up, unknown types, and malformed payloads
 * are all dropped silently — this lane must never crash a run.
 */

import type { Operator } from "./participants/operator.js"
import { emit, type BaroCommand, type BaroEvent } from "./tui-protocol.js"

let generatedConversationSequence = 0

export type PlanningOpenCommand = Extract<BaroCommand, { type: "planning_open" }>
export type PlanFragmentCommand = Extract<BaroCommand, { type: "plan_fragment" }>
export type PlanCompleteCommand = Extract<BaroCommand, { type: "plan_complete" }>
export type PlanFailedCommand = Extract<BaroCommand, { type: "plan_failed" }>

/**
 * Private progressive-planning ingress. The feed owns correlation, payload
 * validation, and lifecycle policy; stdin dispatch only preserves the wire
 * command and must never make the run depend on this optional lane.
 */
export interface PlanningFeed {
    open: (command: PlanningOpenCommand) => void
    fragment: (command: PlanFragmentCommand) => void
    complete: (command: PlanCompleteCommand) => void
    failed: (command: PlanFailedCommand) => void
}

export interface StdinCommandContext {
    /** Null until orchestrate() has joined the Operator to the bus. */
    getOperator: () => Operator | null
    /** Optional and late-bound while the progressive collective is starting. */
    getPlanningFeed?: () => PlanningFeed | null
    /** BaroEvent sink; defaults to the stdout protocol stream. */
    emitEvent?: (ev: BaroEvent) => void
}

export function handleStdinCommand(cmd: BaroCommand, ctx: StdinCommandContext): void {
    if (
        cmd.type === "planning_open" ||
        cmd.type === "plan_fragment" ||
        cmd.type === "plan_complete" ||
        cmd.type === "plan_failed"
    ) {
        dispatchPlanningCommand(cmd, ctx)
        return
    }
    if (cmd.type === "dialogue_message") {
        if (typeof cmd.text !== "string" || !cmd.text.trim()) return
        const operator = ctx.getOperator()
        if (!operator) return
        const text = cmd.text.trim()
        generatedConversationSequence += 1
        const messageId =
            typeof cmd.message_id === "string" && cmd.message_id.trim()
                ? cmd.message_id.trim()
                : `stdin-conversation-${process.pid}-${generatedConversationSequence}`
        ;(ctx.emitEvent ?? emit)({
            type: "conversation_request",
            message_id: messageId,
            text,
        })
        operator.dispatch({
            kind: "converse",
            message: text,
            messageId,
            source: "user",
        })
        ;(ctx.emitEvent ?? emit)({
            type: "story_log",
            id: "_dialogue",
            line: `[you → collective] ${text}`,
        })
        return
    }
    if (cmd.type !== "agent_message") return
    const { id, text } = cmd
    if (typeof id !== "string" || !id || typeof text !== "string" || !text.trim()) return
    const operator = ctx.getOperator()
    if (!operator) return

    // Delivery rides the existing Critic corrective-feedback path: story
    // agents consume AgentTargetedMessage between turns.
    operator.dispatch({ kind: "redirect", storyId: id, message: text, source: "user" })
    // Mirror into the event stream so the message lands in the TUI log,
    // audit JSONL and cloud dashboards.
    ;(ctx.emitEvent ?? emit)({ type: "story_log", id, line: `[you → ${id}] ${text}` })
}

function dispatchPlanningCommand(
    command:
        | PlanningOpenCommand
        | PlanFragmentCommand
        | PlanCompleteCommand
        | PlanFailedCommand,
    ctx: StdinCommandContext,
): void {
    try {
        const feed = ctx.getPlanningFeed?.()
        if (!feed) return
        switch (command.type) {
            case "planning_open":
                feed.open(command)
                return
            case "plan_fragment":
                feed.fragment(command)
                return
            case "plan_complete":
                feed.complete(command)
                return
            case "plan_failed":
                feed.failed(command)
                return
        }
    } catch {
        // This private, additive lane must not crash an otherwise valid run.
    }
}
