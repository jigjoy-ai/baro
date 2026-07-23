/** Baro-local ordered mailboxes and task supervision over Mozaik delivery. */

import {
    BaseObserver,
    type Participant,
    type SemanticEvent,
} from "./mozaik.js"

export interface BackgroundTaskOptions {
    label: string
    /** Same key is ordered; different keys may overlap. */
    key?: string
}

export interface BackgroundTaskHandle {
    /** Always resolves; failures go through the observer failure hook. */
    readonly done: Promise<void>
}

export interface SerializedEventDelivery {
    readonly source: Participant
    readonly event: SemanticEvent<unknown>
    readonly internal: boolean
}

export interface SerializedEventContext extends SerializedEventDelivery {
    publish(event: SemanticEvent<unknown>): void
    spawnTask(
        options: BackgroundTaskOptions,
        work: () => Promise<void> | void,
    ): BackgroundTaskHandle
}

export interface SerializedObserverFailure {
    readonly observer: SerializedObserver
    readonly kind: "mailbox" | "task"
    readonly error: Error
    readonly cause: unknown
    readonly delivery?: SerializedEventDelivery
    readonly task?: Readonly<BackgroundTaskOptions>
}

export interface SerializedObserverOptions {
    onFailure?: (failure: SerializedObserverFailure) => Promise<void> | void
}

interface TrackedTask {
    options: Readonly<BackgroundTaskOptions>
    delivery?: SerializedEventDelivery
}

class KeyedTaskTracker {
    private readonly pending = new Set<Promise<void>>()
    private readonly keyedTails = new Map<string, Promise<void>>()

    constructor(
        private readonly onFailure: (
            error: unknown,
            task: TrackedTask,
        ) => Promise<void>,
    ) {}

    spawn(
        options: BackgroundTaskOptions,
        work: () => Promise<void> | void,
        delivery?: SerializedEventDelivery,
    ): BackgroundTaskHandle {
        const task: TrackedTask = {
            options: Object.freeze({ ...options }),
            ...(delivery ? { delivery } : {}),
        }
        const taskKey = options.key
        const predecessor = taskKey !== undefined
            ? this.keyedTails.get(taskKey) ?? Promise.resolve()
            : Promise.resolve()

        const execution = predecessor.then(async () => {
            await work()
        })
        const supervised = execution.catch(async (error: unknown) => {
            // onFailure is itself guarded by SerializedObserver. Keep this
            // second boundary so BackgroundTaskHandle.done always resolves.
            try {
                await this.onFailure(error, task)
            } catch {
                // A broken diagnostics sink must not poison the task lane.
            }
        })

        this.pending.add(supervised)
        if (taskKey !== undefined) this.keyedTails.set(taskKey, supervised)

        // `supervised` cannot reject. Cleanup in a fulfillment handler avoids
        // the rejected Promise that an ignored `.finally()` can create.
        void supervised.then(() => {
            this.pending.delete(supervised)
            if (
                taskKey !== undefined &&
                this.keyedTails.get(taskKey) === supervised
            ) {
                this.keyedTails.delete(taskKey)
            }
        })

        return { done: supervised }
    }

    get isIdle(): boolean {
        return this.pending.size === 0
    }

    async idle(): Promise<void> {
        while (this.pending.size > 0) {
            await Promise.all([...this.pending])
        }
    }
}

/** Semantic-event decisions are ordered even though Mozaik does not await them. */
export abstract class SerializedObserver extends BaseObserver {
    private mailboxTail: Promise<void> = Promise.resolve()
    private readonly tasks: KeyedTaskTracker

    protected constructor(
        private readonly serializedOptions: SerializedObserverOptions = {},
    ) {
        super()
        this.tasks = new KeyedTaskTracker((error, task) =>
            this.reportFailure({
                kind: "task",
                error: normalizeError(error),
                cause: error,
                observer: this,
                ...(task.delivery ? { delivery: task.delivery } : {}),
                task: task.options,
            }),
        )
    }

    override onInternalEvent(event: SemanticEvent<unknown>): void {
        this.enqueue({ source: this, event, internal: true })
    }

    override onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        this.enqueue({ source, event, internal: false })
    }

    protected abstract handleEvent(
        context: SerializedEventContext,
    ): Promise<void> | void

    protected onManagedFailure(
        _failure: SerializedObserverFailure,
    ): Promise<void> | void {}

    protected publish(event: SemanticEvent<unknown>): void {
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, event)
        }
    }

    protected spawnTask(
        options: BackgroundTaskOptions,
        work: () => Promise<void> | void,
    ): BackgroundTaskHandle {
        return this.tasks.spawn(options, work)
    }

    /** Test/teardown barrier; domain completion still requires a terminal event. */
    async idle(): Promise<void> {
        for (;;) {
            const observedMailbox = this.mailboxTail
            await observedMailbox
            await this.tasks.idle()
            // Let task fulfillment handlers remove their entries and let any
            // synchronously emitted bus event update mailboxTail.
            await Promise.resolve()

            if (
                observedMailbox === this.mailboxTail &&
                this.tasks.isIdle
            ) {
                return
            }
        }
    }

    private enqueue(delivery: SerializedEventDelivery): void {
        const previous = this.mailboxTail
        const decision = previous.then(async () => {
            const context: SerializedEventContext = {
                ...delivery,
                publish: (event) => this.publish(event),
                spawnTask: (options, work) =>
                    this.tasks.spawn(options, work, delivery),
            }
            await this.handleEvent(context)
        })

        // Keep the stored tail fulfilled after a bad decision so the next
        // message still runs. reportFailure contains errors from both hooks.
        this.mailboxTail = decision.catch((error: unknown) =>
            this.reportFailure({
                kind: "mailbox",
                error: normalizeError(error),
                cause: error,
                observer: this,
                delivery,
            }),
        )
    }

    private async reportFailure(
        failure: SerializedObserverFailure,
    ): Promise<void> {
        try {
            await this.onManagedFailure(failure)
        } catch {
            // Never recursively report a failure in the failure hook.
        }

        try {
            await this.serializedOptions.onFailure?.(failure)
        } catch {
            // Diagnostics are best-effort; the mailbox/task lane must survive.
        }
    }
}

function normalizeError(value: unknown): Error {
    if (value instanceof Error) return value
    if (typeof value === "string") return new Error(value)
    try {
        return new Error(JSON.stringify(value) ?? String(value))
    } catch {
        return new Error(String(value))
    }
}
