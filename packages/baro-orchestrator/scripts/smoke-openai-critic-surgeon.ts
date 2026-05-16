#!/usr/bin/env tsx
/**
 * Integration smoke test for the Phase 3 OpenAI siblings.
 *
 * Spawns a BaroEnvironment with CriticOpenAI + SurgeonOpenAI joined,
 * emits a fake AgentResultItem (well-formed agent output, with a
 * realistic acceptance-criteria mismatch) and a fake StoryResultItem
 * (terminal failure), then asserts that the OpenAI participants:
 *
 *   1. Reach the OpenAI API with OPENAI_API_KEY.
 *   2. Return a structured verdict / replan as JSON parseable text.
 *   3. Emit the expected `CritiqueItem` + `AgentTargetedMessageItem`
 *      from CriticOpenAI, and the expected `ReplanItem` from
 *      SurgeonOpenAI, on the same bus, in the same shape, as the
 *      Claude-CLI versions.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx packages/baro-orchestrator/scripts/smoke-openai-critic-surgeon.ts
 *
 * No Claude CLI, no real baro orchestrator run, no PRD file. Pure
 * participant exercise.
 */

import type { Participant } from "@mozaik-ai/core"

import { BaroEnvironment, BaroParticipant, BusEvent } from "../src/bus.js"
import { CriticOpenAI } from "../src/participants/critic-openai.js"
import { SurgeonOpenAI } from "../src/participants/surgeon-openai.js"
import { type PrdSnapshot } from "../src/participants/surgeon.js"
import { StoryResultItem } from "../src/participants/story-agent.js"
import {
    AgentTargetedMessageItem,
    AgentResultItem,
    CritiqueItem,
    ReplanItem,
} from "../src/types.js"

/** Collects every BusEvent the bus delivers, by class name. */
class CollectorParticipant extends BaroParticipant {
    public seen: Array<{ kind: string; event: BusEvent }> = []
    override async onExternalBusEvent(_s: Participant, event: BusEvent): Promise<void> {
        this.seen.push({ kind: event.constructor.name, event })
    }
}

async function main(): Promise<void> {
    if (!process.env.OPENAI_API_KEY) {
        console.error("OPENAI_API_KEY is not set. Export it and re-run.")
        process.exit(1)
    }

    const env = new BaroEnvironment()
    const collector = new CollectorParticipant()
    collector.join(env)

    // ─── CriticOpenAI ────────────────────────────────────────────────

    const critic = new CriticOpenAI({
        targets: new Map([
            ["S1", ["The output must mention 'PONG' verbatim"]],
        ]),
        // gpt-5.4-nano is the cheapest Mozaik-shipped variant, fast
        // enough for a smoke test.
        model: "gpt-5.4-nano",
    })
    critic.join(env)

    // Fake the kind of result a StoryAgent's Claude session would emit
    // — final message text that does NOT mention PONG so we get a
    // "fail" verdict with a corrective message back to the agent.
    const fakeAgentResult = new AgentResultItem(
        "S1",
        "success",
        "fake-session",
        false,
        "I implemented the change. All done.",
        null,
        null,
        2,
        1200,
        {},
    )

    console.log("→ Emitting fake AgentResultItem for S1 (no PONG in output)")
    env.deliverBusEvent(new (class extends BaroParticipant {})(), fakeAgentResult)
    await critic.idle()

    const critiqueEvents = collector.seen.filter((e) => e.event instanceof CritiqueItem)
    const correctiveEvents = collector.seen.filter(
        (e) => e.event instanceof AgentTargetedMessageItem,
    )

    let failed = false
    if (critiqueEvents.length !== 1) {
        console.error(`✗ Expected 1 CritiqueItem, got ${critiqueEvents.length}`)
        failed = true
    } else {
        const c = critiqueEvents[0]!.event as CritiqueItem
        console.log(`✓ CritiqueItem received — verdict=${c.verdict} model=${c.modelUsed}`)
        console.log(`  reasoning: ${c.reasoning.slice(0, 120)}…`)
        if (c.verdict !== "fail") {
            console.error(`  ✗ Expected verdict=fail (output had no PONG), got '${c.verdict}'`)
            failed = true
        }
    }

    if (correctiveEvents.length !== 1) {
        console.error(
            `✗ Expected 1 corrective AgentTargetedMessageItem on fail, got ${correctiveEvents.length}`,
        )
        failed = true
    } else {
        const m = correctiveEvents[0]!.event as AgentTargetedMessageItem
        console.log(`✓ Corrective message received for ${m.recipientId}`)
    }

    // ─── SurgeonOpenAI ───────────────────────────────────────────────

    const surgeon = new SurgeonOpenAI({
        snapshot: (): PrdSnapshot => ({
            project: "smoke-test",
            description: "Test that SurgeonOpenAI proposes a structured replan",
            stories: [
                {
                    id: "S2",
                    title: "Implement the entire backend, frontend, and infra in one story",
                    description:
                        "Add a full multi-region deployment with API, DB schema, " +
                        "frontend SPA, CI pipeline, and Terraform — all in one PR.",
                    dependsOn: [],
                    passes: false,
                },
            ],
        }),
        model: "gpt-5.4-nano",
    })
    surgeon.join(env)

    const fakeFailure = new StoryResultItem(
        "S2",
        false,
        3,
        920,
        "Claude session timed out after 920s — too much scope for one turn",
    )

    console.log("\n→ Emitting fake StoryResultItem(success=false) for S2")
    env.deliverBusEvent(new (class extends BaroParticipant {})(), fakeFailure)
    await surgeon.idle()

    const replans = collector.seen.filter((e) => e.event instanceof ReplanItem)
    if (replans.length !== 1) {
        console.error(`✗ Expected 1 ReplanItem, got ${replans.length}`)
        failed = true
    } else {
        const r = replans[0]!.event as ReplanItem
        console.log(`✓ ReplanItem received — source=${r.source} reason=${r.reason.slice(0, 120)}…`)
        console.log(
            `  added=${r.addedStories.length}, removed=${r.removedStoryIds.length}, modifiedDeps=${r.modifiedDeps.size}`,
        )
    }

    if (failed) {
        console.error("\n✗ Phase 3 smoke test FAILED.")
        process.exit(1)
    }

    console.log("\n✓ Phase 3 smoke test passed.")
    console.log("  CriticOpenAI + SurgeonOpenAI emit the right bus events with the right shape.")
    console.log("  Ready to merge — Phase 4 (Architect → TS + OpenAI) is unblocked.")
    process.exit(0)
}

main().catch((e) => {
    console.error("Smoke test crashed:", e)
    process.exit(2)
})
