import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    AgenticEnvironment,
    type Participant,
    type SemanticEvent,
} from "@mozaik-ai/core"

export type CapturedEnvironment = AgenticEnvironment & {
    events: SemanticEvent<unknown>[]
}

export function source(agentId: string): Participant {
    return { agentId } as unknown as Participant
}

export function captureEnv(): CapturedEnvironment {
    const events: SemanticEvent<unknown>[] = []
    const env = new AgenticEnvironment("participant-test") as CapturedEnvironment
    const deliverSemanticEvent = env.deliverSemanticEvent.bind(env)

    Object.defineProperty(env, "events", {
        enumerable: true,
        value: events,
    })

    env.deliverSemanticEvent = (sourceParticipant, event) => {
        events.push(event)
        deliverSemanticEvent(sourceParticipant, event)
    }

    return env
}

export function joinWithCapture<T extends { join?: unknown; setEnvironment?: unknown }>(
    participant: T,
): CapturedEnvironment {
    const env = captureEnv()

    if (typeof participant.setEnvironment === "function") {
        participant.setEnvironment(env)
    }
    if (typeof participant.join === "function") {
        participant.join(env)
    }

    return env
}

export async function withTempDir(
    prefix: string,
    fn: (dir: string) => Promise<void> | void,
): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    try {
        await fn(dir)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

export async function captureStdout(fn: () => Promise<void> | void): Promise<string[]> {
    const lines: string[] = []
    let buffer = ""
    const originalWrite = process.stdout.write

    process.stdout.write = function writeCapturedStdout(
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
    ): boolean {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
        buffer += text

        let newline = buffer.indexOf("\n")
        while (newline !== -1) {
            const line = buffer.slice(0, newline).trim()
            if (line) lines.push(line)
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf("\n")
        }

        const done = typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback
        done?.()
        return true
    } as typeof process.stdout.write

    try {
        await fn()
    } finally {
        process.stdout.write = originalWrite
        const line = buffer.trim()
        if (line) lines.push(line)
    }

    return lines
}
