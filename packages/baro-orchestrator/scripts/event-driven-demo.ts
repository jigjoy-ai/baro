#!/usr/bin/env tsx
/**
 * Event-driven demo — illustrates Mozaik-native bus reactivity with
 * REAL Claude CLI agents AND a self-healing scenario.
 *
 * Scenario:
 *   S1: setup workspace (always passes)
 *   S2: build using `config.json` — but the file does NOT exist yet,
 *       so this story will FAIL on first attempt
 *   S3: ship the build (depends on S2)
 *
 * What happens on the bus:
 *   1. S1 + S2 spawn in parallel.
 *   2. S2 fails (Claude agent reports missing config.json).
 *   3. **Healer** participant — a custom observer watching the bus —
 *      detects the StoryResult failure, recognizes the missing-file
 *      pattern, and emits a ReplanItem on the bus:
 *        + add new story "FIX-1": create config.json
 *        + add new story "S2-retry": same as S2, depends on FIX-1
 *        + modify S3.dependsOn: [S2] → [S2-retry]
 *   4. Conductor's onContextItem buffers the ReplanItem, applies it
 *      at the level boundary, recomputes the DAG.
 *   5. Next level: [FIX-1] runs, passes. Then [S2-retry] runs, passes
 *      (config.json now exists). Then [S3] runs, passes.
 *
 * The whole cycle is driven by bus events. The Healer doesn't know
 * about the Conductor or the PRD — it just observes StoryResultItem
 * and emits ReplanItem. The Conductor doesn't know about the Healer —
 * it just knows how to apply ReplanItem-s. Pure bus contract.
 *
 * Run:
 *   npx tsx scripts/event-driven-demo.ts
 */

import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, writeFileSync } from "fs"
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
    ReplanItem,
    RunCompletedItem,
    RunStartRequestItem,
    RunStartedItem,
    StorySpawnRequestItem,
    StorySpawnedItem,
} from "../src/types.js"
import { StoryResultItem } from "../src/participants/story-agent.js"

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
    redBg: "\x1b[41m",
}

function ts(): string {
    return new Date().toISOString().slice(11, 19)
}

// ─── Observer 1: lifecycle narrator ────────────────────────────────
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
                : src === "Healer"
                ? COLOR.red + COLOR.bold
                : COLOR.blue

        if (item instanceof RunStartRequestItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}RunStartRequest${COLOR.reset} ${COLOR.dim}(reason: ${item.reason})${COLOR.reset}`,
            )
        } else if (item instanceof RunStartedItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}RunStarted${COLOR.reset} ${COLOR.dim}(${item.storyCount} stories)${COLOR.reset}`,
            )
        } else if (item instanceof LevelComputeRequestItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}LevelComputeRequest${COLOR.reset} ${COLOR.dim}(${item.reason})${COLOR.reset}`,
            )
        } else if (item instanceof LevelStartedItem) {
            console.log(
                `${COLOR.green}${COLOR.bold}━━━ Level ${item.ordinal}: [${item.storyIds.join(", ")}] ━━━${COLOR.reset}`,
            )
        } else if (item instanceof StorySpawnRequestItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}StorySpawnRequest${COLOR.reset} ${COLOR.dim}(${item.storyId})${COLOR.reset}`,
            )
        } else if (item instanceof StorySpawnedItem) {
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}StorySpawned${COLOR.reset} ${COLOR.dim}(${item.storyId})${COLOR.reset}`,
            )
        } else if (item instanceof StoryResultItem) {
            const verdict = item.success
                ? `${COLOR.green}✓ passed${COLOR.reset}`
                : `${COLOR.red}${COLOR.bold}✗ FAILED${COLOR.reset}`
            console.log(
                `${COLOR.dim}[${ts()}]${COLOR.reset} ${sourceColor}${src}${COLOR.reset} → ${COLOR.bold}StoryResult${COLOR.reset} ${item.storyId} ${verdict} ${COLOR.dim}(${item.attempts} attempt(s), ${item.durationSecs}s)${COLOR.reset}`,
            )
            if (!item.success && item.error) {
                console.log(
                    `${COLOR.dim}              error: ${item.error.slice(0, 80)}${COLOR.reset}`,
                )
            }
        } else if (item instanceof ReplanItem) {
            console.log("")
            console.log(
                `${COLOR.red}${COLOR.bold}╭─ HEALING IN PROGRESS ─────────────────────────╮${COLOR.reset}`,
            )
            console.log(
                `${COLOR.red}│ ${sourceColor}${src.padEnd(15)}${COLOR.red} ─→ ReplanItem on the bus       │${COLOR.reset}`,
            )
            console.log(
                `${COLOR.red}│ Reason: ${COLOR.reset}${item.reason.slice(0, 38).padEnd(39)}${COLOR.red}│${COLOR.reset}`,
            )
            if (item.removedStoryIds.length > 0) {
                console.log(
                    `${COLOR.red}│ ${COLOR.reset}Remove: ${item.removedStoryIds.join(", ").slice(0, 39).padEnd(40)}${COLOR.red}│${COLOR.reset}`,
                )
            }
            if (item.addedStories.length > 0) {
                for (const a of item.addedStories) {
                    console.log(
                        `${COLOR.red}│ ${COLOR.reset}${COLOR.green}+ ${a.id}${COLOR.reset}: ${a.title.slice(0, 30).padEnd(30)}    ${COLOR.red}│${COLOR.reset}`,
                    )
                }
            }
            if (item.modifiedDeps.size > 0) {
                for (const [id, deps] of item.modifiedDeps) {
                    console.log(
                        `${COLOR.red}│ ${COLOR.reset}${COLOR.yellow}~ ${id}.deps = [${[...deps].join(",")}]${COLOR.reset}${" ".repeat(Math.max(0, 22 - id.length - [...deps].join(",").length))}    ${COLOR.red}│${COLOR.reset}`,
                    )
                }
            }
            console.log(
                `${COLOR.red}╰────────────────────────────────────────────────╯${COLOR.reset}`,
            )
            console.log("")
        } else if (item instanceof LevelCompletedItem) {
            console.log(
                `${COLOR.green}━━━ Level ${item.ordinal} done: ${item.passed.length} ✓ / ${item.failed.length} ✗ ━━━${COLOR.reset}`,
            )
        } else if (item instanceof RunCompletedItem) {
            console.log("")
            const verdict = item.success
                ? `${COLOR.green}${COLOR.bold}✓ SUCCESS${COLOR.reset}`
                : `${COLOR.red}${COLOR.bold}✗ FAILED${COLOR.reset}`
            console.log(`${verdict} run finished in ${item.totalDurationSecs}s`)
            console.log(
                `        passed: [${item.completedStories.join(", ")}]  failed: [${item.failedStories.join(", ")}]`,
            )
        }
    }
}

// ─── Healer — the heart of the demo ────────────────────────────────
//
// Watches the bus for StoryResultItem failures. When it sees the first
// failure of a story, it emits a ReplanItem that:
//   1. Adds a new "fix-up" story to create the missing prerequisite
//   2. Adds a retry of the failed story (since the original is
//      terminally failed in PRD)
//   3. Rewires downstream dependencies to point to the retry story
//
// Healer knows nothing about the Conductor's internals. It just emits
// a ReplanItem on the bus and trusts the contract. Conductor's
// onContextItem buffers the ReplanItem and applies it at the next
// level boundary.
class Healer extends Participant {
    private envRef: import("@mozaik-ai/core").AgenticEnvironment | null = null
    private healed = false

    setEnvironment(env: import("@mozaik-ai/core").AgenticEnvironment): void {
        this.envRef = env
    }

    async onContextItem(_source: Participant, item: ContextItem): Promise<void> {
        if (this.healed) return // emit at most one replan per run
        if (!(item instanceof StoryResultItem)) return
        if (item.success) return
        if (item.storyId !== "S2") return // only heal S2

        this.healed = true

        console.log(
            `${COLOR.red}${COLOR.bold}[Healer]${COLOR.reset} I observed S2's failure on the bus.`,
        )
        console.log(
            `${COLOR.red}${COLOR.bold}[Healer]${COLOR.reset} Pattern matches "missing prerequisite". Proposing a fix.`,
        )

        const replan = new ReplanItem(
            "Healer",
            "S2 failed because config.json was missing — adding fix-up story FIX-1 to create it, and S2-retry to redo S2 once config.json exists",
            [
                {
                    id: "FIX-1",
                    priority: 0,
                    title: "create config.json",
                    description:
                        "Create a file `config.json` at the repo root with the content " +
                        "`{\"version\": \"1.0\"}`. Stage and commit it with the message " +
                        "'add config.json'.",
                    dependsOn: [],
                    retries: 0,
                    acceptance: ["config.json exists at the repo root"],
                    tests: [],
                },
                {
                    id: "S2-retry",
                    priority: 1,
                    title: "build using config.json (retry)",
                    description:
                        "Read `config.json` at the repo root. Create a file `build.txt` " +
                        "with the content `built version <version-from-config>`. Stage " +
                        "and commit it with the message 'add build.txt'.",
                    dependsOn: ["FIX-1"],
                    retries: 0,
                    acceptance: ["build.txt exists"],
                    tests: [],
                },
            ],
            ["S2"],
            new Map([["S3", ["S2-retry"]]]),
        )

        this.envRef?.deliverContextItem(this, replan)
    }
}

// ─── Observer 3: event counter ─────────────────────────────────────
class EventCounter extends Participant {
    public readonly counts: Map<string, number> = new Map()

    async onContextItem(_source: Participant, item: ContextItem): Promise<void> {
        if (item instanceof ClaudeStreamChunkItem) return
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
        project: "self-healing-demo",
        branchName: "demo/run",
        description: "Mozaik-native event-driven self-healing demo",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "setup workspace",
                description:
                    "Create a `workspace/.keep` file (mkdir -p workspace; touch workspace/.keep). " +
                    "Stage and commit with message 'setup workspace'.",
                dependsOn: [],
                retries: 0,
                acceptance: ["workspace directory exists"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
            {
                id: "S2",
                priority: 1,
                title: "build using config.json",
                description:
                    "Your VERY FIRST action MUST be to run this exact Bash command: " +
                    "`test -f config.json || (echo 'BLOCKED: config.json missing — orchestrator must fix' && sleep 120)`. " +
                    "Do NOT create config.json. Do NOT skip this command. Do NOT replace the sleep with anything shorter. " +
                    "If config.json exists, the command exits 0 immediately and you can proceed: " +
                    "read it, parse the version field, create `build.txt` with content " +
                    "`built version <version-from-config>`, then commit.",
                dependsOn: [],
                retries: 0,
                acceptance: ["build.txt exists with version"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
            {
                id: "S3",
                priority: 2,
                title: "ship the build (depends on S2)",
                description:
                    "Verify that `build.txt` exists. Create `SHIPPED` (an empty file) " +
                    "alongside it. Stage and commit both with message 'ship the build'.",
                dependsOn: ["S2"],
                retries: 0,
                acceptance: ["SHIPPED exists"],
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

    console.log(
        `${COLOR.bold}${COLOR.cyan}╭─ Mozaik-native self-healing demo ─────────────────╮${COLOR.reset}`,
    )
    console.log(
        `${COLOR.bold}${COLOR.cyan}│ Real Claude CLI agents on a Mozaik bus            │${COLOR.reset}`,
    )
    console.log(
        `${COLOR.bold}${COLOR.cyan}│ S1 setup, S2 build (will FAIL), S3 ship           │${COLOR.reset}`,
    )
    console.log(
        `${COLOR.bold}${COLOR.cyan}│ Healer observes → emits ReplanItem → fix flows in │${COLOR.reset}`,
    )
    console.log(
        `${COLOR.bold}${COLOR.cyan}╰───────────────────────────────────────────────────╯${COLOR.reset}`,
    )
    console.log(``)
    console.log(`Repo: ${cwd}`)
    console.log(``)
    console.log(
        `${COLOR.dim}Watch for the HEALING block — that's a custom observer (Healer)${COLOR.reset}`,
    )
    console.log(
        `${COLOR.dim}reacting to S2's failure and proposing fix-up stories on the bus.${COLOR.reset}`,
    )
    console.log(
        `${COLOR.dim}The Conductor doesn't know about Healer — they only share ReplanItem.${COLOR.reset}`,
    )
    console.log(``)

    const counter = new EventCounter()
    const healer = new Healer()
    const narrator = new LifecycleNarrator()

    // Healer needs an env ref to emit. orchestrate.ts wires extra
    // participants by joining them; we set the env ref out-of-band
    // because there's no setEnvironment call in extraParticipants.
    // A small monkey-patch via override:
    const origJoin = healer.join.bind(healer)
    healer.join = function (env) {
        healer.setEnvironment(env)
        return origJoin(env)
    } as typeof healer.join

    const result = await orchestrate({
        prdPath,
        cwd,
        parallel: 2,
        timeoutSecs: 30,
        defaultModel: "sonnet",
        emitTuiEvents: false,
        withGit: true,
        withLibrarian: false,
        withSentry: false,
        withSurgeon: false, // we use our own Healer instead
        extraParticipants: [narrator, healer, counter],
    })

    console.log(``)
    console.log(`${COLOR.bold}━━━ Event counts (sorted) ━━━${COLOR.reset}`)
    const sorted = [...counter.counts.entries()].sort((a, b) => b[1] - a[1])
    for (const [type, count] of sorted) {
        console.log(`  ${type.padEnd(35)} ${count}`)
    }

    console.log(``)
    console.log(`${COLOR.bold}━━━ File checks ━━━${COLOR.reset}`)
    const files = [
        "workspace/.keep",
        "config.json",
        "build.txt",
        "SHIPPED",
    ]
    for (const f of files) {
        const exists = existsSync(join(cwd, f))
        const mark = exists ? `${COLOR.green}✓${COLOR.reset}` : `${COLOR.red}✗${COLOR.reset}`
        console.log(`  ${mark} ${f}`)
    }

    console.log(``)
    console.log(`${COLOR.bold}━━━ Final summary ━━━${COLOR.reset}`)
    console.log(`  passed:  [${result.summary.completedStories.join(", ")}]`)
    console.log(`  failed:  [${result.summary.failedStories.join(", ")}]`)
    console.log(`  attempts: ${result.summary.totalAttempts}`)
    console.log(`  duration: ${result.summary.totalDurationSecs}s`)
    console.log(``)
    console.log(`${COLOR.dim}Repo retained: ${cwd}${COLOR.reset}`)
}

main().catch((e: unknown) => {
    console.error(`fatal: ${(e as Error)?.stack ?? String(e)}`)
    process.exit(1)
})
