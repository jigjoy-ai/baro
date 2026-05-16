#!/usr/bin/env tsx
/**
 * Smoke test for the Mozaik 3.9.3 upgrade adapter.
 *
 * Wires a BaroEnvironment with three subscribers:
 *   1. An emitter — uses deliverBusEvent + Mozaik typed deliver methods
 *   2. An observer — implements all relevant onExternal* handlers and
 *      records what arrives
 *   3. A Conductor-style self-ticker — emits to itself and verifies
 *      onBusEvent path
 *
 * Then emits a representative mix of events and prints the routing
 * tally. Exit 0 if everything wired up correctly, 1 if any check fails.
 *
 * No Claude CLI, no real LLM — pure adapter-layer verification.
 */

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
    Participant,
    ReasoningItem,
} from "@mozaik-ai/core"

import { BaroEnvironment, BaroParticipant, BusEvent } from "../src/bus.js"
import {
    AgentStateItem,
    AgentUserMessageItem,
    ClaudeResultItem,
    StorySpawnRequestItem,
} from "../src/types.js"

interface Counters {
    busSelf: number
    busExternal: number
    modelMessage: number
    functionCall: number
    functionCallOutput: number
    reasoning: number
}

class Emitter extends BaroParticipant {}

class Observer extends BaroParticipant {
    counts: Counters = {
        busSelf: 0,
        busExternal: 0,
        modelMessage: 0,
        functionCall: 0,
        functionCallOutput: 0,
        reasoning: 0,
    }
    lastBusEvent: BusEvent | null = null

    override async onBusEvent(_e: BusEvent): Promise<void> {
        this.counts.busSelf++
    }

    override async onExternalBusEvent(_s: Participant, event: BusEvent): Promise<void> {
        this.counts.busExternal++
        this.lastBusEvent = event
    }

    override async onExternalModelMessage(_s: Participant, _i: ModelMessageItem): Promise<void> {
        this.counts.modelMessage++
    }

    override async onExternalFunctionCall(_s: Participant, _i: FunctionCallItem): Promise<void> {
        this.counts.functionCall++
    }

    override async onExternalFunctionCallOutput(
        _s: Participant,
        _i: FunctionCallOutputItem,
    ): Promise<void> {
        this.counts.functionCallOutput++
    }

    override async onExternalReasoning(_s: Participant, _i: ReasoningItem): Promise<void> {
        this.counts.reasoning++
    }
}

/** A self-ticker: emits a BusEvent to itself and expects onBusEvent to fire. */
class SelfTicker extends BaroParticipant {
    selfTickCount = 0
    externalCount = 0

    override async onBusEvent(_e: BusEvent): Promise<void> {
        this.selfTickCount++
    }

    override async onExternalBusEvent(_s: Participant, _e: BusEvent): Promise<void> {
        this.externalCount++
    }

    tick(env: BaroEnvironment): void {
        env.deliverBusEvent(this, new AgentStateItem("self-tick", "running", "from self"))
    }
}

async function main(): Promise<void> {
    const env = new BaroEnvironment()
    const emitter = new Emitter()
    const observer = new Observer()
    const ticker = new SelfTicker()

    emitter.join(env)
    observer.join(env)
    ticker.join(env)

    // ─── BusEvent fan-out (the new adapter channel) ─────────────────

    env.deliverBusEvent(emitter, new AgentStateItem("agent-1", "running", "from emitter"))
    env.deliverBusEvent(
        emitter,
        new StorySpawnRequestItem("S1", "implement the typo fix", undefined, 2, 600),
    )
    env.deliverBusEvent(
        emitter,
        new ClaudeResultItem("agent-1", "success", "session-1", false, "done", null, null, 1, 100, {}),
    )
    env.deliverBusEvent(emitter, new AgentUserMessageItem("agent-1", "hello agent"))

    // ─── Mozaik typed delivery (assistant-side items) ───────────────

    env.deliverModelMessage(emitter, ModelMessageItem.rehydrate({ text: "hi from claude" }))
    env.deliverFunctionCall(
        emitter,
        FunctionCallItem.rehydrate({
            callId: "call-1",
            name: "Read",
            args: JSON.stringify({ file_path: "README.md" }),
        }),
    )
    env.deliverFunctionCallOutput(
        emitter,
        FunctionCallOutputItem.create("call-1", "README contents"),
    )

    // ─── Self-tick (Conductor pattern) ──────────────────────────────

    ticker.tick(env)
    ticker.tick(env)
    ticker.tick(env)

    // Give async handlers a tick to settle (all our handlers are sync
    // under the hood but typed as async; one microtask is enough).
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 10))

    // ─── Verify ─────────────────────────────────────────────────────

    const failures: string[] = []
    function check(label: string, actual: number, expected: number): void {
        if (actual === expected) {
            console.log(`  ✓ ${label}: ${actual}`)
        } else {
            console.log(`  ✗ ${label}: expected ${expected}, got ${actual}`)
            failures.push(label)
        }
    }

    // Observer is subscriber to bus, receives all external emissions:
    // 4 from emitter + 3 from ticker = 7 external BusEvents. Observer
    // never emits, so onBusEvent (self) should be 0.
    console.log("\nObserver (pure subscriber) counters:")
    check("BusEvent (external, 4 emitter + 3 ticker)", observer.counts.busExternal, 7)
    check("BusEvent (self)", observer.counts.busSelf, 0)
    check("ModelMessage", observer.counts.modelMessage, 1)
    check("FunctionCall", observer.counts.functionCall, 1)
    check("FunctionCallOutput", observer.counts.functionCallOutput, 1)
    check("Reasoning", observer.counts.reasoning, 0)

    // Ticker emits 3 BusEvents to itself and receives 4 from emitter.
    // Self path → onBusEvent fires 3 times. External path → ticker is
    // a subscriber, so the 4 emitter events arrive on onExternalBusEvent.
    console.log("\nSelfTicker counters:")
    check("Self emissions → onBusEvent (3 self-ticks)", ticker.selfTickCount, 3)
    check("Foreign emissions → onExternalBusEvent (4 emitter events)", ticker.externalCount, 4)

    if (failures.length > 0) {
        console.log(`\n✗ FAILED: ${failures.length} check(s) did not match expectations`)
        process.exit(1)
    }
    console.log("\n✓ All routing checks passed — Mozaik 3.9.3 adapter is wired correctly.")
    process.exit(0)
}

main().catch((e) => {
    console.error("Smoke test crashed:", e)
    process.exit(2)
})
