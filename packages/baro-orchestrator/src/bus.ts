/**
 * Adapter layer that lets the baro orchestrator keep its typed
 * domain-event bus on top of Mozaik 3.9.x.
 *
 * Mozaik 3.9 ships typed delivery only for LLM-shaped items
 * (FunctionCall, ModelMessage, Reasoning, FunctionCallOutput) plus a
 * bare-string `deliverMessage`. baro orchestration uses its own
 * typed events — story spawn requests, level completion, agent state,
 * shared knowledge, replans — that don't fit any of those. The
 * adapter below extends the Mozaik environment with a single extra
 * `deliverBusEvent` channel that carries our typed events, and
 * subclasses Participant so every concrete orchestrator participant
 * gets both Mozaik's LLM handlers and our bus handlers.
 *
 * Naming: `BusEvent` is the in-process orchestrator event type. Not
 * to be confused with `BaroEvent` in `tui-protocol.ts`, which is the
 * stdout JSON shape consumed by the Rust TUI.
 */

import {
    AgenticEnvironment,
    BaseAgentParticipant,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    ReasoningItem,
} from "@mozaik-ai/core"

/**
 * Base class for typed orchestrator events flowing through the
 * `BaroEnvironment` bus. Subclasses declare a literal `type` string
 * and any payload fields; the default `toJSON` shallow-copies fields
 * for audit logging, which subclasses can override when they have
 * non-trivial shapes (e.g. nested objects with their own `toJSON`).
 */
export abstract class BusEvent {
    abstract readonly type: string

    toJSON(): unknown {
        const out: Record<string, unknown> = { type: this.type }
        for (const [key, value] of Object.entries(this)) {
            if (key !== "type") out[key] = value
        }
        return out
    }
}

/**
 * Mozaik-native environment extended with a typed bus-event channel.
 * Every baro orchestrator subscribes a `BaroEnvironment` (not the
 * vanilla `AgenticEnvironment`) so participants can use either the
 * Mozaik LLM delivery methods or the custom `deliverBusEvent` path.
 */
export class BaroEnvironment extends AgenticEnvironment {
    /**
     * Self-emitted: the `source` participant receives `onBusEvent`.
     * Every other subscriber receives `onExternalBusEvent`. Mirrors
     * Mozaik's symmetry for built-in delivery methods. Subscribers
     * that aren't `BaroParticipant` instances are silently skipped.
     */
    deliverBusEvent(source: Participant, event: BusEvent): void {
        for (const subscriber of this.subscribers) {
            const sub = subscriber as Participant & {
                onBusEvent?: (event: BusEvent) => Promise<void> | void
                onExternalBusEvent?: (
                    source: Participant,
                    event: BusEvent,
                ) => Promise<void> | void
            }
            if (subscriber === source) {
                void sub.onBusEvent?.(event)
            } else {
                void sub.onExternalBusEvent?.(source, event)
            }
        }
    }
}

/**
 * Base for orchestrator participants that don't drive their own LLM
 * inference loop (Conductor, Librarian, Sentry, Auditor, Cartographer,
 * Finalizer, Operator, StoryFactory) plus participants that wrap an
 * external LLM CLI (Critic, Surgeon, ClaudeCliParticipant).
 *
 * Provides no-op defaults for every abstract Mozaik handler so
 * subclasses implement only what they care about, plus the
 * `onBusEvent` / `onExternalBusEvent` pair for custom bus events.
 */
export abstract class BaroParticipant extends Participant {
    onJoined(): Promise<void> | void {}
    onLeft(): Promise<void> | void {}
    onParticipantJoined(_p: Participant): Promise<void> | void {}
    onParticipantLeft(_p: Participant): Promise<void> | void {}
    onFunctionCall(_item: FunctionCallItem): Promise<void> | void {}
    onExternalFunctionCall(_s: Participant, _item: FunctionCallItem): Promise<void> | void {}
    onFunctionCallOutput(_item: FunctionCallOutputItem): Promise<void> | void {}
    onExternalFunctionCallOutput(
        _s: Participant,
        _item: FunctionCallOutputItem,
    ): Promise<void> | void {}
    onReasoning(_item: ReasoningItem): Promise<void> | void {}
    onExternalReasoning(_s: Participant, _item: ReasoningItem): Promise<void> | void {}
    onModelMessage(_item: ModelMessageItem): Promise<void> | void {}
    onExternalModelMessage(_s: Participant, _item: ModelMessageItem): Promise<void> | void {}
    onMessage(_message: string): Promise<void> | void {}

    onBusEvent(_event: BusEvent): Promise<void> | void {}
    onExternalBusEvent(_source: Participant, _event: BusEvent): Promise<void> | void {}
}

/**
 * Base for participants that drive their own inference loop on a
 * Mozaik OpenAI inference runner. Used in Phase 3+ for the OpenAI
 * sibling participants (CriticOpenAI, ArchitectOpenAI, PlannerOpenAI,
 * SurgeonOpenAI, OpenAIAgentParticipant). Not used in Phase 1 — kept
 * here so the LLM-side adapter shape is established alongside the
 * non-LLM one and the two share the same `onBusEvent` channel.
 */
export abstract class BaroAgentParticipant extends BaseAgentParticipant {
    onBusEvent(_event: BusEvent): Promise<void> | void {}
    onExternalBusEvent(_source: Participant, _event: BusEvent): Promise<void> | void {}
}
