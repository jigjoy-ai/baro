/**
 * Operator — bridge from external user-input commands (Rust TUI today,
 * web UI later) to the Mozaik bus. The Operator joins the environment
 * but only emits on demand: callers invoke `dispatch(cmd)` when a
 * command arrives over the TUI protocol, and Operator translates it
 * into bus events.
 *
 * Library-grade: knows nothing about TUI specifics, only about the
 * canonical command shape and how to express it as bus events.
 */

import { AgenticEnvironment, BaseObserver, SemanticEvent } from "@mozaik-ai/core"

import {
    AgentTargetedMessage,
    ConversationRequested,
} from "../semantic-events.js"

export type OperatorCommand =
    /** `source` tags who authored the message ("user" for TUI chat); defaults to "operator". */
    | { kind: "redirect"; storyId: string; message: string; source?: string }
    | {
          kind: "converse"
          message: string
          messageId?: string
          source?: "user" | "operator"
      }
    | { kind: "abort"; storyId: string }
    | { kind: "abort_all" }
    | { kind: "shutdown" }

export interface OperatorHooks {
    /** Called when an `abort` command arrives. */
    onAbort?: (storyId: string) => void
    /** Called when `abort_all` arrives. */
    onAbortAll?: () => void
    /** Called when `shutdown` arrives. */
    onShutdown?: () => void
}

export interface OperatorOptions {
    /** Enables correlated conversation requests for this run. */
    runId?: string
}

export class Operator extends BaseObserver {
    private envRef: AgenticEnvironment | null = null
    private conversationSequence = 0

    constructor(
        private readonly hooks: OperatorHooks = {},
        private readonly opts: OperatorOptions = {},
    ) {
        super()
    }

    setEnvironment(env: AgenticEnvironment): void {
        this.envRef = env
    }

    // Operator is push-only: it emits in response to external commands,
    // never reacts to bus events. Default BaseObserver no-op handlers
    // cover everything.

    /** Translate an external command into bus action / hook callback. */
    dispatch(cmd: OperatorCommand): void {
        switch (cmd.kind) {
            case "redirect": {
                this.emit(
                    AgentTargetedMessage.create({
                        recipientId: cmd.storyId,
                        text: cmd.message,
                        metadata: { source: cmd.source ?? "operator" },
                    }),
                )
                return
            }
            case "converse": {
                const runId = this.opts.runId
                const text = cmd.message.trim()
                if (!runId || !text) return
                this.conversationSequence += 1
                this.emit(
                    ConversationRequested.create({
                        runId,
                        messageId:
                            cmd.messageId ??
                            `${runId}:conversation:${this.conversationSequence}`,
                        text,
                        source: cmd.source ?? "operator",
                    }),
                )
                return
            }
            case "abort": {
                this.hooks.onAbort?.(cmd.storyId)
                return
            }
            case "abort_all": {
                this.hooks.onAbortAll?.()
                return
            }
            case "shutdown": {
                this.hooks.onShutdown?.()
                return
            }
        }
    }

    private emit(event: SemanticEvent<unknown>): void {
        this.envRef?.deliverSemanticEvent(this, event)
    }
}
