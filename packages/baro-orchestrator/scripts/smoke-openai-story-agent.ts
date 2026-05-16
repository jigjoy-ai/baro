#!/usr/bin/env tsx
/**
 * Integration smoke test for the Phase 6 OpenAI StoryAgent.
 *
 * Spawns a throwaway scratch dir with a single tiny file containing
 * a known typo, wires up an OpenAIStoryAgent on a BaroEnvironment,
 * and lets it run the story end-to-end against real OpenAI. Asserts:
 *
 *   1. The agent reached a terminal `done` state.
 *   2. The typo is actually fixed on disk after the agent exits.
 *   3. The agent emitted at least one FunctionCallItem (it used a
 *      tool) and one AgentResultItem (turn completed cleanly).
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx packages/baro-orchestrator/scripts/smoke-openai-story-agent.ts
 *
 * Cost: roughly $0.05 with gpt-5.4-mini for the model.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { FunctionCallItem, type Participant } from "@mozaik-ai/core"

import { BaroEnvironment, BaroParticipant, BusEvent } from "../src/bus.js"
import { OpenAIStoryAgent } from "../src/participants/openai-story-agent.js"
import { AgentStateItem, AgentResultItem } from "../src/types.js"

class Collector extends BaroParticipant {
    public readonly busEvents: BusEvent[] = []
    public readonly functionCalls: FunctionCallItem[] = []

    override async onExternalBusEvent(_s: Participant, e: BusEvent): Promise<void> {
        this.busEvents.push(e)
    }

    override async onExternalFunctionCall(_s: Participant, i: FunctionCallItem): Promise<void> {
        this.functionCalls.push(i)
    }
}

async function main(): Promise<void> {
    if (!process.env.OPENAI_API_KEY) {
        console.error("OPENAI_API_KEY is not set. Export it and re-run.")
        process.exit(1)
    }

    const dir = mkdtempSync(join(tmpdir(), "baro-story-smoke-"))
    const targetFile = join(dir, "NOTES.md")
    writeFileSync(targetFile, "This is a typoo on a single line.\n")
    console.log(`Scratch dir: ${dir}`)

    const env = new BaroEnvironment()
    const collector = new Collector()
    collector.join(env)

    const agent = new OpenAIStoryAgent(
        {
            id: "S1",
            prompt:
                "Fix the typo in NOTES.md: change 'typoo' to 'typo'. The file " +
                "is in the current working directory. Use edit_file. Do NOT " +
                "commit or run git — there is no git repo here. When the change " +
                "is made, respond with a brief summary and stop.",
            cwd: dir,
            retries: 1,
            maxTurns: 2,
        },
        { model: "gpt-5.4-mini", maxRoundsPerTurn: 12, perRoundTimeoutSecs: 60 },
    )
    agent.join(env)

    console.log("→ Spawning OpenAIStoryAgent with gpt-5.4-mini …")
    const t0 = Date.now()
    const outcome = await agent.run(env)
    const elapsed = Date.now() - t0

    let failed = false
    function check(label: string, ok: boolean, detail?: string): void {
        const tag = ok ? "✓" : "✗"
        console.log(`  ${tag} ${label}${detail ? ` (${detail})` : ""}`)
        if (!ok) failed = true
    }

    console.log(`\nFinished in ${elapsed}ms — outcome:`, outcome)

    check(
        "agent reached terminal success",
        outcome.success === true,
        outcome.error ?? "no error",
    )
    check("attempt count is at most 2", outcome.attempts <= 2, `${outcome.attempts}`)

    const onDisk = readFileSync(targetFile, "utf-8").trim()
    check(
        "NOTES.md contains 'typo' (not 'typoo')",
        onDisk.includes("typo") && !onDisk.includes("typoo"),
        JSON.stringify(onDisk),
    )

    check(
        "at least one FunctionCallItem fired on the bus",
        collector.functionCalls.length > 0,
        `${collector.functionCalls.length} calls`,
    )

    const stateTransitions = collector.busEvents.filter((e) => e instanceof AgentStateItem)
    check(
        "saw 'done' state transition",
        stateTransitions.some((e) => (e as AgentStateItem).phase === "done"),
        `${stateTransitions.length} state events`,
    )

    const resultItems = collector.busEvents.filter((e) => e instanceof AgentResultItem)
    check(
        "at least one AgentResultItem emitted (turn end)",
        resultItems.length >= 1,
        `${resultItems.length} result events`,
    )

    try {
        rmSync(dir, { recursive: true, force: true })
    } catch {
        // ignore
    }

    if (failed) {
        console.error("\n✗ Phase 6 smoke test FAILED.")
        process.exit(1)
    }
    console.log("\n✓ Phase 6 smoke test passed — OpenAIStoryAgent edits files end-to-end.")
    process.exit(0)
}

main().catch((e) => {
    console.error("Smoke test crashed:", e)
    process.exit(2)
})
