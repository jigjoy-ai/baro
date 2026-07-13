import {
    BaseObserver,
    type ModelMessageItem,
    type Participant,
    type SemanticEvent,
} from "@mozaik-ai/core"

import {
    AgentTurnCompleted,
    CodexTurnEvent,
    OpenCodeSystem,
    PiTurnEvent,
    StoryRouted,
} from "../semantic-events.js"
import type { StoryOutcomeAuthority } from "../runtime/story-outcome-authority.js"

export interface AgentTurnProjectorOptions {
    /** Collective-only exact authority for native CLI event producers. */
    outcomeAuthority?: StoryOutcomeAuthority
}

/** Projects one-shot CLI message streams into the Critic's neutral terminal contract. */
export class AgentTurnProjector extends BaseObserver {
    private readonly text = new Map<string, string[]>()
    private readonly backends = new Map<string, string>()
    private readonly completed = new Set<string>()
    private readonly terminalSequences = new Map<string, number>()
    private readonly nativeSources = new Map<string, Participant>()

    constructor(private readonly opts: AgentTurnProjectorOptions = {}) {
        super()
    }

    override async onExternalModelMessage(
        source: Participant,
        item: ModelMessageItem,
    ): Promise<void> {
        const agentId = agentIdOf(source)
        if (!agentId) return
        if (!this.acceptsNativeSource(source, agentId)) return
        this.selectNativeSource(source, agentId)
        // A new assistant message is positive evidence that a new turn/attempt
        // started after any previously projected terminal event.
        this.completed.delete(agentId)
        const json = item.toJSON() as { content?: Array<{ text?: string }> }
        const parts = (json.content ?? [])
            .map((part) => part.text ?? "")
            .filter((part) => part.length > 0)
        if (parts.length === 0) return
        const existing = this.text.get(agentId) ?? []
        existing.push(...parts)
        // Bound audit/prompt memory while retaining the latest assistant output.
        const joined = existing.join("\n")
        this.text.set(agentId, [joined.slice(-100_000)])
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (StoryRouted.is(event)) {
            this.backends.set(event.data.storyId, event.data.backend)
            return
        }
        if (CodexTurnEvent.is(event)) {
            if (!this.acceptsNativeSource(source, event.data.agentId)) return
            this.selectNativeSource(source, event.data.agentId)
            if (event.data.phase === "started") this.completed.delete(event.data.agentId)
            else if (event.data.phase === "completed") this.complete(event.data.agentId, "codex", false)
            else if (event.data.phase === "failed") this.complete(event.data.agentId, "codex", true)
            return
        }
        if (OpenCodeSystem.is(event)) {
            if (!this.acceptsNativeSource(source, event.data.agentId)) return
            this.selectNativeSource(source, event.data.agentId)
            if (event.data.subtype === "step_start") this.completed.delete(event.data.agentId)
            else if (event.data.subtype === "step_finish") {
                this.complete(event.data.agentId, "opencode", false)
            }
            return
        }
        if (PiTurnEvent.is(event)) {
            if (!this.acceptsNativeSource(source, event.data.agentId)) return
            this.selectNativeSource(source, event.data.agentId)
            if (event.data.turnType === "message_start") {
                this.completed.delete(event.data.agentId)
            } else if (event.data.turnType === "message_end") {
                const raw = event.data.raw as Record<string, unknown>
                const message = raw.message as Record<string, unknown> | undefined
                if (message?.role === "assistant") this.complete(event.data.agentId, "pi", false)
            }
        }
    }

    private acceptsNativeSource(source: Participant, agentId: string): boolean {
        return this.opts.outcomeAuthority === undefined ||
            this.opts.outcomeAuthority.matchesTerminalTurnSource(source, agentId)
    }

    private selectNativeSource(source: Participant, agentId: string): void {
        // Legacy adapters historically reconstruct lightweight source objects
        // around the same agentId. Exact identity is meaningful only when the
        // collective registry is present.
        if (!this.opts.outcomeAuthority) return
        const current = this.nativeSources.get(agentId)
        if (current && current !== source) {
            this.text.delete(agentId)
            this.completed.delete(agentId)
        }
        this.nativeSources.set(agentId, source)
    }

    private complete(agentId: string, fallbackBackend: string, isError: boolean): void {
        if (this.completed.has(agentId)) return
        this.completed.add(agentId)
        const resultText = (this.text.get(agentId) ?? []).join("\n").trim()
        this.text.delete(agentId)
        const sequence = (this.terminalSequences.get(agentId) ?? 0) + 1
        this.terminalSequences.set(agentId, sequence)
        const event = AgentTurnCompleted.create({
            agentId,
            terminalId: ["projected", agentId, sequence]
                .map(String)
                .map(encodeURIComponent)
                .join(":"),
            backend: this.backends.get(agentId) ?? fallbackBackend,
            isError,
            resultText: resultText || null,
            canContinue: false,
        })
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, event)
        }
    }
}

function agentIdOf(source: Participant): string | null {
    const id = (source as { agentId?: unknown }).agentId
    return typeof id === "string" && id ? id : null
}
