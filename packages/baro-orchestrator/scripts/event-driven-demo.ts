#!/usr/bin/env tsx
/**
 * Event-driven demo — illustrates Mozaik-native bus reactivity with
 * REAL Claude CLI agents. Unlike phase4-demo (control vs treatment),
 * this script's purpose is purely educational: show what flows on the
 * bus and which participant reacts to what.
 *
 * 3 short stories run in parallel (≤ 30s each):
 *   S1: write a 1-line README.md
 *   S2: write a 1-line LICENSE.txt
 *   S3: write a 1-line VERSION (depends on S1)
 *
 * Custom observers attached:
 *   • LifecycleNarrator — prints a story narrative ("Conductor asked
 *     for level 1 …", "S1 completed → Conductor moved to level 2")
 *   • StoryReactor — reacts to OTHER agents' StoryResultItem events
 *     (proves cross-agent reactivity, not just Conductor → workers)
 *   • EventCounter — running totals per event type, printed at end
 *
 * Run:
 *   npx tsx scripts/event-driven-demo.ts
 */

import { execFileSync } from "child_process"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { ContextItem, Participant } from "@mozaik-ai/core"

import { orchestrate } from "../src/orchestrate.js"
import type { PrdFile } from "../src/main.js"
import {
    ClaudeStreamChunkItem,
    LevelComputeRequestItem,
    LevelCompletedItem,
    LevelStartedItem,
    RunCompletedItem,
    RunStartRequestItem,
    RunStartedItem,
    StorySpawnRequestItem,
    StorySpawnedItem,
} from "../src/types.js"
import { StoryResultItem } from "../src/participants/story-agent.js"
import { ConductorStateItem } from "../src/participants/conductor.js"

const COLOR = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
}

function ts(): string {
    return new Date().toISOString().slice(11, 19)
}

// ─── Observer 1: narrate the lifecycle ────────────────────────────
//
// Subscribes to high-level orchestration events and prints a clear
// human-readable narrative. Demonstrates that the entire run flow is
// observable from outside the Conductor.
class LifecycleNarrator extends Participant {
    async onContextItem(source: Participant, item: ContextItem): Promise<void> {
        const src = source.constructor.name
        const sourceColor =
            src === "Conductor"
                ? COLOR.cyan
                : src === "StoryFactory"
                ? COLOR.magenta
                : src === "Operator"
                ? COLOR.yellow
                : COLOR.blue

        if (item instanceof RunStartRequestItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}RunStartRequest${COLOR.reset} ${COLOR.dim}(reason: ${item.reason})${COLOR.reset}`,
            )
            console.log(
                `${COLOR.dim}              └→ Conductor will pick this up via onContextItem${COLOR.reset}`,
            )
        } else if (item instanceof RunStartedItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}RunStarted${COLOR.reset} ${COLOR.dim}(${item.storyCount} stories, project="${item.project}")${COLOR.reset}`,
            )
        } else if (item instanceof LevelComputeRequestItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}LevelComputeRequest${COLOR.reset} ${COLOR.dim}(${item.reason}) — Conductor self-ticks${COLOR.reset}`,
            )
        } else if (item instanceof LevelStartedItem) {
            console.log(
                `${COLOR.green}${COLOR.bold}━━━ Level ${item.ordinal}/${item.totalLevelsHint} starting: [${item.storyIds.join(", ")}] ━━━${COLOR.reset}`,
            )
        } else if (item instanceof StorySpawnRequestItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}StorySpawnRequest${COLOR.reset} ${COLOR.dim}(${item.storyId}, model=${item.model})${COLOR.reset}`,
            )
            console.log(
                `${COLOR.dim}              └→ StoryFactory will react and create the agent${COLOR.reset}`,
            )
        } else if (item instanceof StorySpawnedItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}StorySpawned${COLOR.reset} ${COLOR.dim}(${item.storyId} agent is now on the bus)${COLOR.reset}`,
            )
        } else if (item instanceof StoryResultItem) {
            const verdict = item.success ? `${COLOR.green}✓ passed${COLOR.reset}` : `${COLOR.red}✗ failed${COLOR.reset}`
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}StoryResult${COLOR.reset} ${item.storyId} ${verdict} ${COLOR.dim}(${item.attempts} attempt(s), ${item.durationSecs}s)${COLOR.reset}`,
            )
            console.log(
                `${COLOR.dim}              └→ Conductor will update level state via onContextItem${COLOR.reset}`,
            )
        } else if (item instanceof LevelCompletedItem) {
            console.log(
                `${COLOR.green}━━━ Level ${item.ordinal} complete: ${item.passed.length} passed, ${item.failed.length} failed ━━━${COLOR.reset}`,
            )
        } else if (item instanceof RunCompletedItem) {
            const verdict = item.success
                ? `${COLOR.green}${COLOR.bold}✓ SUCCESS${COLOR.reset}`
                : `${COLOR.red}${COLOR.bold}✗ FAILED${COLOR.reset}`
            console.log("")
            console.log(`${verdict} run finished in ${item.totalDurationSecs}s`)
            console.log(
                `        passed: [${item.completedStories.join(", ")}]  failed: [${item.failedStories.join(", ")}]`,
            )
        }
    }
}

// ─── Observer 2: cross-agent reactivity ────────────────────────────
//
// Reacts to OTHER agents' StoryResultItem events. This demonstrates
// that participants can build behavior on top of each other's output
// without Conductor being involved at all. Pure observer-pattern
// extensibility.
class StoryReactor extends Participant {
    private successes = 0

    async onContextItem(source: Participant, item: ContextItem): Promise<void> {
        if (item instanceof StoryResultItem && item.success) {
            this.successes += 1
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${COLOR.yellow}StoryReactor${COLOR.reset} reacted to ${COLOR.bold}${item.storyId}${COLOR.reset}'s success — running tally: ${COLOR.green}${this.successes}${COLOR.reset} pass(es) so far`,
            )
        }
    }
}

// ─── Observer 3: event counter ─────────────────────────────────────
//
// Tracks total counts per event type. Printed at end as a summary.
class EventCounter extends Participant {
    public readonly counts: Map<string, number> = new Map()

    async onContextItem(_source: Participant, item: ContextItem): Promise<void> {
        if (item instanceof ClaudeStreamChunkItem) return // skip noise
        const t = (item as { type?: string }).type ?? item.constructor.name
        this.counts.set(t, (this.counts.get(t) ?? 0) + 1)
    }
}

// ─── Setup helpers ──────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" })
}

function setupRepo(): string {
    const cwd = mkdtempSync(join(tmpdir(), "baro-event-demo-"))
    git(cwd, ["init", "-q", "-b", "main"])
    git(cwd, ["config", "user.email", "demo@baro.test"])
    git(cwd, ["config", "user.name", "Event Demo"])
    writeFileSync(join(cwd, ".keep"), "")
    git(cwd, ["add", "."])
    git(cwd, ["commit", "-q", "-m", "initial"])
    return cwd
}

function buildPrd(): PrdFile {
    return {
        project: "event-driven-demo",
        branchName: "demo/run",
        description: "Mozaik-native event-driven flow demo",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "Add README",
                description:
                    "Create a `README.md` at the repo root containing the single line " +
                    "'event demo'. Stage and commit with message 'add README'.",
                dependsOn: [],
                retries: 0,
                acceptance: ["README.md exists"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
            {
                id: "S2",
                priority: 1,
                title: "Add LICENSE",
                description:
                    "Create a `LICENSE.txt` at the repo root containing the single line " +
                    "'MIT'. Stage and commit with message 'add LICENSE'.",
                dependsOn: [],
                retries: 0,
                acceptance: ["LICENSE.txt exists"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
            {
                id: "S3",
                priority: 2,
                title: "Add VERSION (depends on S1)",
                description:
                    "Create a `VERSION` file at the repo root containing the single line " +
                    "'0.1.0'. Stage and commit with message 'add VERSION'.",
                dependsOn: ["S1"],
                retries: 0,
                acceptance: ["VERSION exists"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
        ],
    }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const cwd = setupRepo()
    const prdPath = join(cwd, "prd.json")
    writeFileSync(prdPath, JSON.stringify(buildPrd(), null, 2) + "\n")

    console.log(`${COLOR.bold}${COLOR.cyan}╭─ Mozaik-native event-driven demo ────────────────╮${COLOR.reset}`)
    console.log(`${COLOR.bold}${COLOR.cyan}│ Real Claude CLI agents on a Mozaik bus           │${COLOR.reset}`)
    console.log(`${COLOR.bold}${COLOR.cyan}│ 3 stories: S1, S2 (parallel) → S3 depends on S1  │${COLOR.reset}`)
    console.log(`${COLOR.bold}${COLOR.cyan}╰──────────────────────────────────────────────────╯${COLOR.reset}`)
    console.log(``)
    console.log(`Repo: ${cwd}`)
    console.log(``)
    console.log(
        `${COLOR.dim}Watch how participants react to each other's events on the bus.${COLOR.reset}`,
    )
    console.log(
        `${COLOR.dim}Conductor never directly calls anyone — it only emits & receives events.${COLOR.reset}`,
    )
    console.log(``)

    const counter = new EventCounter()
    const reactor = new StoryReactor()
    const narrator = new LifecycleNarrator()

    const result = await orchestrate({
        prdPath,
        cwd,
        parallel: 2, // S1 and S2 in parallel
        timeoutSecs: 30,
        defaultModel: "sonnet",
        emitTuiEvents: false,
        withGit: true,
        withLibrarian: false,
        withSentry: false,
        withSurgeon: false,
        extraParticipants: [narrator, reactor, counter],
    })

    console.log(``)
    console.log(`${COLOR.bold}━━━ Event counts (sorted) ━━━${COLOR.reset}`)
    const sorted = [...counter.counts.entries()].sort((a, b) => b[1] - a[1])
    for (const [type, count] of sorted) {
        console.log(`  ${type.padEnd(35)} ${count}`)
    }

    console.log(``)
    console.log(`${COLOR.bold}━━━ Final summary ━━━${COLOR.reset}`)
    console.log(`  passed:  [${result.summary.completedStories.join(", ")}]`)
    console.log(`  failed:  [${result.summary.failedStories.join(", ")}]`)
    console.log(`  attempts: ${result.summary.totalAttempts}`)
    console.log(`  duration: ${result.summary.totalDurationSecs}s`)
    console.log(``)
    console.log(`${COLOR.dim}Repo retained for inspection: ${cwd}${COLOR.reset}`)
}

main().catch((e: unknown) => {
    console.error(`fatal: ${(e as Error)?.stack ?? String(e)}`)
    process.exit(1)
})
