/** Shared event factory: wire type string + frozen-snapshot create() + is() guard. Wire `type` strings are frozen (see ../semantic-events.ts). */

import { SemanticEvent } from "../runtime/mozaik.js"

/**
 * One event "kind": wire type string + typed `create()` factory + `is()`
 * type guard — class-event ergonomics without a JS class identity.
 */
export function defineSemanticEvent<TData>(type: string) {
    return {
        type,
        create: (data: TData): SemanticEvent<TData> => {
            // Mozaik delivers the same event object synchronously to every
            // subscriber, while several Baro participants defer decisions to
            // an async mailbox. Snapshot and freeze at the producer boundary
            // so an earlier subscriber cannot rewrite what a later authority
            // observes, and callers cannot mutate an event after publishing it.
            const snapshot = deepFreezeSemanticData(structuredClone(data))
            return Object.freeze(new SemanticEvent<TData>(type, snapshot))
        },
        is: (event: SemanticEvent<unknown>): event is SemanticEvent<TData> =>
            event.type === type,
    } as const
}

function deepFreezeSemanticData<T>(value: T, seen = new WeakSet<object>()): T {
    if (value === null || typeof value !== "object") return value
    const object = value as object
    if (seen.has(object)) return value
    seen.add(object)

    // Semantic payloads are wire values (plain records/arrays plus primitive
    // leaves). Reflective traversal also safely freezes structured-cloned Date,
    // Map and Set wrappers should a diagnostic payload contain one.
    if (value instanceof Map) {
        for (const [key, item] of value) {
            deepFreezeSemanticData(key, seen)
            deepFreezeSemanticData(item, seen)
        }
    } else if (value instanceof Set) {
        for (const item of value) deepFreezeSemanticData(item, seen)
    }
    for (const key of Reflect.ownKeys(object)) {
        deepFreezeSemanticData(
            (object as Record<PropertyKey, unknown>)[key],
            seen,
        )
    }
    return Object.freeze(value)
}
