/**
 * TUI→orchestrator stdin command dispatch. Additive channel: commands
 * arriving before the bus is up, unknown types, and malformed payloads
 * are all dropped silently — this lane must never crash a run.
 */

import type { Operator } from "./participants/operator.js"
import { emit, type BaroCommand, type BaroEvent } from "./tui-protocol.js"

export interface StdinCommandContext {
    /** Null until orchestrate() has joined the Operator to the bus. */
    getOperator: () => Operator | null
    /** BaroEvent sink; defaults to the stdout protocol stream. */
    emitEvent?: (ev: BaroEvent) => void
}

export function handleStdinCommand(cmd: BaroCommand, ctx: StdinCommandContext): void {
    if (cmd.type === "dialogue_message") {
        if (typeof cmd.text !== "string" || !cmd.text.trim()) return
        const operator = ctx.getOperator()
        if (!operator) return
        operator.dispatch({
            kind: "converse",
            message: cmd.text,
            messageId:
                typeof cmd.message_id === "string" && cmd.message_id.trim()
                    ? cmd.message_id.trim()
                    : undefined,
            source: "user",
        })
        ;(ctx.emitEvent ?? emit)({
            type: "story_log",
            id: "_dialogue",
            line: `[you → collective] ${cmd.text}`,
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
