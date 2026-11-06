/**
 * Baro's coordination runtime: a bus that members join, publish semantic events
 * to, and observe each other through. It runs on a Mozaik runtime (one per bus);
 * nothing outside this file and ./mozaik.ts sees Mozaik's runtime types.
 *
 * Delivery contract (relied on by every observer, see execution/OBSERVERS.md):
 * - a publish reaches every member synchronously, in join order;
 * - the publisher itself gets `onInternalEvent`, everyone else `onExternalEvent`
 *   with the publishing member as `source` (which need not have joined);
 * - handlers are not awaited, so members order their own work (SerializedObserver).
 */

import { randomUUID } from "node:crypto"

import {
    defineRuntime,
    Participant,
    RuntimeState,
    SemanticEvent,
    SituationSpecification,
    type FunctionCallItem,
    type FunctionCallOutputItem,
    type ModelMessageItem,
    type ReasoningItem,
    type SituationContext,
} from "./mozaik.js"

type Hook = Promise<void> | void

/** A participant on one or more buses. Hooks default to no-ops. */
export abstract class BusMember {
    readonly busId: string = randomUUID()
    private readonly buses: CoordinationBus[] = []

    join(bus: CoordinationBus): void {
        if (this.buses.includes(bus)) return
        bus.admit(this)
        this.buses.push(bus)
    }

    leave(bus: CoordinationBus): void {
        if (!this.buses.includes(bus)) return
        bus.release(this)
        this.buses.splice(this.buses.indexOf(bus), 1)
    }

    getBuses(): readonly CoordinationBus[] {
        return [...this.buses]
    }

    onJoined(): Hook {}
    onLeft(): Hook {}
    onInternalEvent(_event: SemanticEvent<string, unknown>): Hook {}
    onExternalEvent(_source: BusMember, _event: SemanticEvent<string, unknown>): Hook {}
    onExternalFunctionCall(_source: BusMember, _item: FunctionCallItem): Hook {}
    onExternalFunctionCallOutput(_source: BusMember, _item: FunctionCallOutputItem): Hook {}
    onExternalModelMessage(_source: BusMember, _item: ModelMessageItem): Hook {}
    onExternalReasoning(_source: BusMember, _item: ReasoningItem): Hook {}
}

// Model items travel on the Mozaik runtime as semantic events of these types.
const ITEM = {
    functionCall: "baro.bus.function_call",
    functionCallOutput: "baro.bus.function_call_output",
    modelMessage: "baro.bus.model_message",
    reasoning: "baro.bus.reasoning",
} as const
const MOZAIK_LIFECYCLE = new Set(["participant.joined", "participant.left"])

class BusState extends RuntimeState {}

class EveryEvent extends SituationSpecification {
    isSatisfiedBy(): boolean {
        return true
    }
}

/** The Mozaik participant standing in for one member on one bus. */
class MemberSeat extends Participant {
    constructor(member: BusMember, deliver: (member: BusMember, event: SemanticEvent) => void) {
        super(
            { id: member.busId, name: member.constructor.name, role: "agent" },
            [
                {
                    specification: new EveryEvent(),
                    processor: { apply: ({ event }: SituationContext) => deliver(member, event) },
                },
            ],
        )
    }
}

export class CoordinationBus {
    private readonly runtime: ReturnType<ReturnType<typeof defineRuntime<BusState>>["initializeRuntime"]>
    private readonly seats = new Map<BusMember, MemberSeat>()
    // Delivery is synchronous, so the innermost publish in progress is the source of what is being delivered.
    private readonly sources: BusMember[] = []

    constructor(readonly name?: string) {
        this.runtime = defineRuntime<BusState>().initializeRuntime({ state: new BusState() })
    }

    /** Called by `BusMember.join`; members join through that, not here. */
    admit(member: BusMember): void {
        const seat = new MemberSeat(member, (to, event) => this.deliver(to, event))
        this.seats.set(member, seat)
        this.runtime.join(seat)
        void member.onJoined()
    }

    /** Called by `BusMember.leave`. */
    release(member: BusMember): void {
        const seat = this.seats.get(member)
        if (!seat) return
        void member.onLeft()
        this.seats.delete(member)
        this.runtime.leave(seat)
    }

    // The event object is delivered as published: observers rely on its identity, so the
    // publisher travels as `source` rather than being stamped into a copy.
    publish(source: BusMember, event: SemanticEvent<string, unknown>): void {
        this.send(source, event)
    }

    publishFunctionCall(source: BusMember, item: FunctionCallItem): void {
        this.send(source, SemanticEvent.create(ITEM.functionCall, source.busId, item))
    }

    publishFunctionCallOutput(source: BusMember, item: FunctionCallOutputItem): void {
        this.send(source, SemanticEvent.create(ITEM.functionCallOutput, source.busId, item))
    }

    publishModelMessage(source: BusMember, item: ModelMessageItem): void {
        this.send(source, SemanticEvent.create(ITEM.modelMessage, source.busId, item))
    }

    publishReasoning(source: BusMember, item: ReasoningItem): void {
        this.send(source, SemanticEvent.create(ITEM.reasoning, source.busId, item))
    }

    private send(source: BusMember, event: SemanticEvent): void {
        this.sources.push(source)
        try {
            this.runtime.publish(event)
        } finally {
            this.sources.pop()
        }
    }

    private deliver(member: BusMember, event: SemanticEvent): void {
        if (MOZAIK_LIFECYCLE.has(event.type)) return
        const source = this.sources.at(-1)
        if (!source) return
        if (member === source) {
            if (!isItem(event.type)) void member.onInternalEvent(event)
            return
        }
        switch (event.type) {
            case ITEM.functionCall:
                void member.onExternalFunctionCall(source, event.payload as FunctionCallItem)
                return
            case ITEM.functionCallOutput:
                void member.onExternalFunctionCallOutput(source, event.payload as FunctionCallOutputItem)
                return
            case ITEM.modelMessage:
                void member.onExternalModelMessage(source, event.payload as ModelMessageItem)
                return
            case ITEM.reasoning:
                void member.onExternalReasoning(source, event.payload as ReasoningItem)
                return
            default:
                void member.onExternalEvent(source, event)
        }
    }
}

const isItem = (type: string): boolean => (Object.values(ITEM) as string[]).includes(type)
