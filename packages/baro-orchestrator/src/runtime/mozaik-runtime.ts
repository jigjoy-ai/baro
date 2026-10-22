import {
    createAgent,
    createHuman,
    defineRuntime,
    Participant as RuntimeParticipant,
    RuntimeState,
    SemanticEvent as RuntimeEvent,
    SituationSpecification,
    type SituationContext,
    type SituationHandler,
    type SituationProcessor,
} from "@mozaik-ai/core"
import type {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    ReasoningItem,
    SemanticEvent,
} from "mozaik-core-v3"

export {
    createAgent,
    createHuman,
    RuntimeEvent,
    RuntimeParticipant,
    SituationSpecification,
}
export type {
    InterceptionHandler,
    SituationContext,
    SituationHandler,
    SituationProcessor,
} from "@mozaik-ai/core"

export class BaroRuntimeState extends RuntimeState {}

type Runtime = ReturnType<
    ReturnType<typeof defineRuntime<BaroRuntimeState>>["initializeRuntime"]
>
type ParticipantClass = abstract new (...args: never[]) => Participant

export abstract class Participant {
    private environments: AgenticEnvironment[] = []
    protected listens: ParticipantClass[] = []

    join(environment: AgenticEnvironment): void {
        if (this.isJoinedTo(environment)) return
        environment.subscribe(this)
        this.environments.push(environment)
    }

    leave(environment: AgenticEnvironment): void {
        if (!this.isJoinedTo(environment)) return
        environment.unsubscribe(this)
        this.environments = this.environments.filter((e) => e !== environment)
    }

    protected isJoinedTo(environment: AgenticEnvironment): boolean {
        return this.environments.includes(environment)
    }

    getEnvironments(): AgenticEnvironment[] {
        return this.environments
    }

    getListeners(): ParticipantClass[] {
        return this.listens
    }

    abstract onParticipantJoined(participant: Participant): Promise<void> | void
    abstract onParticipantLeft(participant: Participant): Promise<void> | void
    abstract onJoined(): Promise<void> | void
    abstract onLeft(): Promise<void> | void
    abstract onFunctionCall(item: FunctionCallItem): Promise<void> | void
    abstract onExternalFunctionCall(source: Participant, item: FunctionCallItem): Promise<void> | void
    abstract onFunctionCallOutput(item: FunctionCallOutputItem): Promise<void> | void
    abstract onExternalFunctionCallOutput(source: Participant, item: FunctionCallOutputItem): Promise<void> | void
    abstract onReasoning(item: ReasoningItem): Promise<void> | void
    abstract onExternalReasoning(source: Participant, item: ReasoningItem): Promise<void> | void
    abstract onModelMessage(item: ModelMessageItem): Promise<void> | void
    abstract onExternalModelMessage(source: Participant, item: ModelMessageItem): Promise<void> | void
    abstract onMessage(message: string): Promise<void> | void
    abstract onInternalEvent(item: SemanticEvent<unknown>): Promise<void> | void
    abstract onExternalEvent(source: Participant, item: SemanticEvent<unknown>): Promise<void> | void
}

export class BaseObserver extends Participant {
    onFunctionCall(_item: FunctionCallItem): void {}
    onExternalFunctionCall(_source: Participant, _item: FunctionCallItem): void {}
    onFunctionCallOutput(_item: FunctionCallOutputItem): void {}
    onExternalFunctionCallOutput(_source: Participant, _item: FunctionCallOutputItem): void {}
    onReasoning(_item: ReasoningItem): void {}
    onExternalReasoning(_source: Participant, _item: ReasoningItem): void {}
    onModelMessage(_item: ModelMessageItem): void {}
    onExternalModelMessage(_source: Participant, _item: ModelMessageItem): void {}
    onMessage(_message: string): void {}
    onJoined(): void {}
    onLeft(): void {}
    onParticipantJoined(_participant: Participant): void {}
    onParticipantLeft(_participant: Participant): void {}
    onInternalEvent(_item: SemanticEvent<unknown>): void {}
    onExternalEvent(_source: Participant, _item: SemanticEvent<unknown>): void {}
}

interface Channels {
    function_call: FunctionCallItem
    function_call_output: FunctionCallOutputItem
    reasoning: ReasoningItem
    model_message: ModelMessageItem
    message: string
    semantic: SemanticEvent<unknown>
}
type Channel = keyof Channels

interface Route<T> {
    /** Mozaik v4 event type and payload, so runtime-native participants read baro traffic. */
    wire(item: T): { type: string; payload: unknown }
    internal?(self: Participant, item: T): unknown
    external(target: Participant, source: Participant, item: T): unknown
}

const ROUTES: { [C in Channel]: Route<Channels[C]> } = {
    function_call: {
        wire: (call) => ({ type: "function_call.started", payload: { call } }),
        internal: (self, item) => self.onFunctionCall(item),
        external: (target, source, item) => target.onExternalFunctionCall(source, item),
    },
    function_call_output: {
        wire: (output) => ({ type: "function_call.completed", payload: output }),
        internal: (self, item) => self.onFunctionCallOutput(item),
        external: (target, source, item) => target.onExternalFunctionCallOutput(source, item),
    },
    reasoning: {
        wire: (reasoning) => ({ type: "reasoning", payload: reasoning }),
        internal: (self, item) => self.onReasoning(item),
        external: (target, source, item) => target.onExternalReasoning(source, item),
    },
    model_message: {
        wire: (answer) => ({ type: "model.answer", payload: { answer } }),
        internal: (self, item) => self.onModelMessage(item),
        external: (target, source, item) => target.onExternalModelMessage(source, item),
    },
    message: {
        wire: (message) => ({ type: "message.sent", payload: { message } }),
        external: (target, _source, message) => target.onMessage(message),
    },
    semantic: {
        wire: (event) => ({ type: event.type, payload: event.data }),
        internal: (self, item) => self.onInternalEvent(item),
        external: (target, source, item) => target.onExternalEvent(source, item),
    },
}

// Sources are not always joined (or even Participants), so ids live beside them.
const producerIds = new WeakMap<object, string>()
function producerIdOf(source: unknown): string {
    if (typeof source !== "object" || source === null) return "unknown"
    let id = producerIds.get(source)
    if (!id) {
        id = crypto.randomUUID()
        producerIds.set(source, id)
    }
    return id
}

class BusDelivery extends RuntimeEvent {
    constructor(
        readonly channel: Channel,
        readonly source: Participant,
        readonly item: Channels[Channel],
    ) {
        const { type, payload } = (ROUTES[channel] as Route<unknown>).wire(item)
        super(type, producerIdOf(source), new Date(), payload)
    }
}

class BusMember extends RuntimeParticipant {
    constructor(
        readonly member: Participant,
        readonly environment: AgenticEnvironment,
    ) {
        super(
            {
                id: producerIdOf(member),
                name: member.constructor.name || "Participant",
                role: "agent",
                capabilities: [],
            },
            MEMBER_HANDLERS,
        )
    }
}

class OwnDelivery extends SituationSpecification {
    isSatisfiedBy({ event, participant }: SituationContext): boolean {
        return event instanceof BusDelivery &&
            participant instanceof BusMember &&
            event.source === participant.member
    }
}

class AudibleDelivery extends SituationSpecification {
    isSatisfiedBy({ event, participant }: SituationContext): boolean {
        if (!(event instanceof BusDelivery) || !(participant instanceof BusMember)) return false
        const { source } = event
        const listeners = participant.member.getListeners()
        return source !== participant.member &&
            (listeners.length === 0 || listeners.some((listener) => source instanceof listener))
    }
}

class MembershipChange extends SituationSpecification {
    constructor(private readonly type: "participant.joined" | "participant.left") {
        super()
    }

    isSatisfiedBy({ event, participant }: SituationContext): boolean {
        return !(event instanceof BusDelivery) &&
            participant instanceof BusMember &&
            event.type === this.type
    }
}

const deliverOwn: SituationProcessor = {
    apply({ event, participant }) {
        const delivery = event as BusDelivery
        const route = ROUTES[delivery.channel] as Route<unknown>
        route.internal?.((participant as BusMember).member, delivery.item)
    },
}

const deliverAudible: SituationProcessor = {
    apply({ event, participant }) {
        const delivery = event as BusDelivery
        const route = ROUTES[delivery.channel] as Route<unknown>
        route.external((participant as BusMember).member, delivery.source, delivery.item)
    },
}

const announceJoin: SituationProcessor = {
    apply({ event, participant }) {
        const self = participant as BusMember
        if (event.producerId === self.getId()) {
            self.member.onJoined()
            return
        }
        const other = self.environment.participantById(event.producerId)
        if (other) self.member.onParticipantJoined(other)
    },
}

const announceLeave: SituationProcessor = {
    apply({ event, participant }) {
        const self = participant as BusMember
        const other = self.environment.participantById(event.producerId)
        if (other) self.member.onParticipantLeft(other)
    },
}

const MEMBER_HANDLERS: SituationHandler[] = [
    { specification: new OwnDelivery(), processor: deliverOwn },
    { specification: new AudibleDelivery(), processor: deliverAudible },
    { specification: new MembershipChange("participant.joined"), processor: announceJoin },
    { specification: new MembershipChange("participant.left"), processor: announceLeave },
]

function isolated(handler: SituationHandler): SituationHandler {
    const report = (error: unknown) => process.stderr.write(
        `[mozaik] runtime participant handler failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return {
        specification: handler.specification,
        processor: {
            apply(context) {
                try {
                    const pending = handler.processor.apply(context)
                    if (pending instanceof Promise) pending.catch(report)
                } catch (error) {
                    report(error)
                }
            },
        },
    }
}

/**
 * Baro's bus on a Mozaik v4 runtime: each joined baro participant is a runtime
 * member whose situation handlers route events to its v3-shaped callbacks, so
 * delivery order, self/other split and `listens` filtering are unchanged.
 */
export class AgenticEnvironment {
    readonly runtime: Runtime
    private readonly members = new Map<Participant, BusMember>()
    private isActive = false

    constructor(readonly name?: string) {
        this.runtime = defineRuntime<BaroRuntimeState>().initializeRuntime({
            state: new BaroRuntimeState(),
        })
    }

    subscribe(participant: Participant): void {
        if (this.members.has(participant)) return
        const member = new BusMember(participant, this)
        this.members.set(participant, member)
        this.runtime.join(member)
    }

    unsubscribe(participant: Participant): void {
        const member = this.members.get(participant)
        if (!member) return
        participant.onLeft()
        this.runtime.leave(member)
        this.members.delete(participant)
    }

    participantById(id: string): Participant | undefined {
        for (const [participant, member] of this.members) {
            if (member.getId() === id) return participant
        }
        return undefined
    }

    /** Joins a runtime-native participant; its failures never interrupt baro delivery. */
    admit(participant: RuntimeParticipant): void {
        participant.setHandlers(participant.getHandlers().map(isolated))
        this.runtime.join(participant)
    }

    dismiss(participant: RuntimeParticipant): void {
        this.runtime.leave(participant)
    }

    deliverFunctionCall(source: Participant, item: FunctionCallItem): void {
        this.runtime.publish(new BusDelivery("function_call", source, item))
    }

    deliverModelMessage(source: Participant, item: ModelMessageItem): void {
        this.runtime.publish(new BusDelivery("model_message", source, item))
    }

    deliverReasoning(source: Participant, item: ReasoningItem): void {
        this.runtime.publish(new BusDelivery("reasoning", source, item))
    }

    deliverFunctionCallOutput(source: Participant, item: FunctionCallOutputItem): void {
        this.runtime.publish(new BusDelivery("function_call_output", source, item))
    }

    deliverMessage(source: Participant, message: string): void {
        this.runtime.publish(new BusDelivery("message", source, message))
    }

    deliverSemanticEvent(source: Participant, item: SemanticEvent<unknown>): void {
        this.runtime.publish(new BusDelivery("semantic", source, item))
    }

    async start(): Promise<void> {
        this.isActive = true
        while (this.isActive) {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }

    stop(): void {
        this.isActive = false
    }
}
