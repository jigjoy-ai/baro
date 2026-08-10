import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    AgenticEnvironment,
    type Participant,
    type SemanticEvent,
} from "../../src/runtime/mozaik.js"

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

const INJECTED_JIGJOY_ENV = Object.freeze({
    BARO_JIGJOY_ENV_INJECTED: "1",
    OPENAI_API_KEY: "gk_v1.injected-secret",
    OPENAI_BASE_URL: "https://gw.baro.jigjoy.ai/v1",
    JIGJOY_API_KEY: "gk_v1.injected-secret",
    BARO_JIGJOY_URL: "https://gw.baro.jigjoy.ai/v1",
    BARO_GATEWAY_BILLING_URL: "https://gw.baro.jigjoy.ai/v1",
    BARO_GATEWAY_BILLING_API_KEY: "gk_v1.injected-secret",
    BARO_RUN_ID: "run-local-preserved",
    BARO_TEST_UNRELATED: "keep-me",
})

export async function withInjectedJigJoyEnvironment(
    fn: () => Promise<void> | void,
): Promise<void> {
    const before = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(INJECTED_JIGJOY_ENV)) {
        before.set(key, process.env[key])
        process.env[key] = value
    }
    try {
        await fn()
        for (const [key, value] of Object.entries(INJECTED_JIGJOY_ENV)) {
            assert.equal(process.env[key], value, `parent environment mutated: ${key}`)
        }
    } finally {
        for (const [key, value] of before) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

/** JavaScript statement for a fake Node CLI to persist its selected env. */
export function harnessEnvironmentCaptureProgram(path: string): string {
    return `writeFileSync(${JSON.stringify(path)}, JSON.stringify({
  marker: process.env.BARO_JIGJOY_ENV_INJECTED ?? null,
  openaiKey: process.env.OPENAI_API_KEY ?? null,
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? null,
  jigjoyKey: process.env.JIGJOY_API_KEY ?? null,
  jigjoyUrl: process.env.BARO_JIGJOY_URL ?? null,
  billingUrl: process.env.BARO_GATEWAY_BILLING_URL ?? null,
  billingKey: process.env.BARO_GATEWAY_BILLING_API_KEY ?? null,
  runId: process.env.BARO_RUN_ID ?? null,
  unrelated: process.env.BARO_TEST_UNRELATED ?? null
}));`
}

export function assertHarnessEnvironmentWasSanitized(path: string): void {
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
        marker: null,
        openaiKey: null,
        openaiBaseUrl: null,
        jigjoyKey: null,
        jigjoyUrl: null,
        billingUrl: null,
        billingKey: null,
        runId: "run-local-preserved",
        unrelated: "keep-me",
    })
}

/**
 * How long a test may wait for the operating system to start a spawned fixture
 * and for that fixture to announce itself.
 *
 * None of these tests measure spawn latency — they measure what happens once
 * the child exists. A wait returns the moment it appears, so a generous ceiling
 * costs a healthy machine nothing, while a tight one fails correct code
 * whenever the suite runs alongside anything else. The old 5–10s ceilings did
 * exactly that: three suspension tests and two one-shot tests failed at 10.01s
 * under load and passed in isolation, and the cost lands on whoever has to
 * prove the red was not theirs.
 */
export const SPAWNED_FIXTURE_DEADLINE_MS = 60_000

/**
 * Per-attempt ceiling for harness tests whose subject is not the timeout.
 *
 * A ceiling near the cost of starting a process stops measuring the code and
 * starts measuring the machine: under load a fixture that exits non-zero is
 * cut off instead, which is a different failure class and one the agents
 * deliberately do not retry locally — so a test counting attempts sees one
 * where it required two. The lane whose tests already used a named generous
 * ceiling is the one that never flaked. A test that really is about timeouts
 * states a fractional ceiling and means it.
 */
export const FIXTURE_TIMEOUT_SECS = 60
