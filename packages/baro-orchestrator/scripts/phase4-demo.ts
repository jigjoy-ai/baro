#!/usr/bin/env tsx
/**
 * Phase 4 demo: adaptive DAG via Surgeon.
 *
 * Setup: a 3-story PRD where S2 is engineered to fail (impossibly
 * short timeout), and S3 transitively depends on S2.
 *
 *   ┌────┐    ┌────┐ (will fail)    ┌────┐
 *   │ S1 │    │ S2 │ ───────────►   │ S3 │
 *   └────┘    └────┘                └────┘
 *
 * Pass A — `withSurgeon: false` (control):
 *   S1 passes; S2 burns its retry budget hitting timeout;
 *   the next iteration's only-incomplete level is just [S2];
 *   it fails again with no peer to share success → aborted run;
 *   S3 never runs.
 *
 * Pass B — `withSurgeon: true` (treatment):
 *   S1 passes; S2 burns its retry budget;
 *   Surgeon emits a ReplanItem removing S2;
 *   Conductor applies it at the level boundary;
 *   the next iteration's DAG = [S3] (its dep on S2 is now stripped);
 *   S3 runs and passes.
 *
 * This proves the bus-driven adaptive-DAG path works end-to-end
 * (Surgeon → ReplanItem → Conductor.applyReplan → recomputed DAG →
 * downstream story unblocked).
 */

import { execFileSync } from "child_process"
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { ContextItem, Participant } from "@mozaik-ai/core"

import { orchestrate } from "../src/orchestrate.js"
import type { PrdFile } from "../src/main.js"
import { ClaudeStreamChunkItem } from "../src/types.js"

// Live logger: prints every bus event to stderr as it happens, so you
// can see what each participant is doing in real time.
class LiveLogger extends Participant {
    constructor(private readonly label: string) {
        super()
    }
    async onContextItem(source: Participant, item: ContextItem): Promise<void> {
        // Skip token-by-token streaming chunks (too noisy)
        if (item instanceof ClaudeStreamChunkItem) return

        const sourceName = source.constructor.name
        const agentId = (source as unknown as { agentId?: string }).agentId
        const sourceLabel = agentId ? `${sourceName}:${agentId}` : sourceName

        const itemJson = item.toJSON() as Record<string, unknown>
        const itemType = (itemJson.type as string) ?? item.constructor.name

        // Extract a short summary of interesting fields
        const interesting: string[] = []
        for (const k of ["storyId", "status", "decision", "reason", "level", "outcome", "removed", "added"]) {
            const v = itemJson[k]
            if (v !== undefined && v !== null) {
                const s = typeof v === "string" ? v : JSON.stringify(v)
                interesting.push(`${k}=${s.length > 60 ? s.slice(0, 57) + "..." : s}`)
            }
        }
        const summary = interesting.length > 0 ? "  " + interesting.join(" ") : ""

        const ts = new Date().toLocaleTimeString("en-GB")
        process.stderr.write(`  [${this.label} ${ts}] ${sourceLabel} → ${itemType}${summary}\n`)
    }
}

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" })
}

function setupRepo(): string {
    const cwd = mkdtempSync(join(tmpdir(), "baro-phase4-"))
    git(cwd, ["init", "-q", "-b", "main"])
    git(cwd, ["config", "user.email", "phase4@baro.test"])
    git(cwd, ["config", "user.name", "Phase 4"])
    writeFileSync(
        join(cwd, "README.md"),
        "# baro-phase4-demo\n\nAdaptive DAG demo.\n",
    )
    git(cwd, ["add", "."])
    git(cwd, ["commit", "-q", "-m", "initial"])
    return cwd
}

function buildPrd(): PrdFile {
    return {
        project: "baro-phase4-demo",
        branchName: "phase4/run",
        description: "Phase 4 surgeon demo",
        userStories: [
            {
                id: "S1",
                priority: 1,
                title: "Add NOTES.md",
                description:
                    "Create a `NOTES.md` file at the repo root containing the single line " +
                    "'phase 4 demo'. Stage and commit it with the message 'add NOTES.md'. " +
                    "Be quick — a few seconds of work.",
                dependsOn: [],
                retries: 0,
                acceptance: ["NOTES.md exists with the expected content"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
            {
                id: "S2",
                // S2 is engineered to fail via timeout. The prompt
                // requires a long-running bash command that the per-story
                // timeout (set in runPass below) cuts short, forcing the
                // Claude process to exit with a non-zero code. Sonnet
                // cannot creatively shortcut around this — even if it
                // skips the sleep, the polling loop after it ensures
                // wall-clock duration exceeds the timeout.
                priority: 1,
                title: "(designed to fail) extended bash work",
                description:
                    "You are testing a long-running build process. " +
                    "Run a Bash command that sleeps for 60 seconds and then writes " +
                    "the line 'done' into a file `S2.txt`. The exact command MUST be: " +
                    "`sleep 60 && echo done > S2.txt`. Do NOT use a shorter sleep, do " +
                    "NOT skip the sleep, do NOT split the command. After the bash " +
                    "command exits, run `git add S2.txt && git commit -m 'add S2.txt'`.",
                dependsOn: [],
                retries: 0,
                acceptance: [
                    "S2.txt exists at the repo root",
                    "the bash sleep ran for the full 60 seconds",
                ],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
            {
                id: "S3",
                priority: 2,
                title: "Add CHANGELOG.md (depends on S2)",
                description:
                    "Create a `CHANGELOG.md` file at the repo root with the single line " +
                    "'phase 4 changelog initial'. Commit with message 'add CHANGELOG.md'.",
                dependsOn: ["S2"],
                retries: 0,
                acceptance: ["CHANGELOG.md exists at repo root"],
                tests: [],
                passes: false,
                completedAt: null,
                durationSecs: null,
            },
        ],
    }
}

interface AuditEntry {
    ts: string
    source: string
    item: { type: string; [key: string]: unknown }
}

function countByType(auditPath: string, type: string): number {
    if (!existsSync(auditPath)) return 0
    let count = 0
    for (const line of readFileSync(auditPath, "utf8").split("\n")) {
        if (!line.trim()) continue
        let entry: AuditEntry
        try {
            entry = JSON.parse(line) as AuditEntry
        } catch {
            continue
        }
        if (entry.item.type === type) count++
    }
    return count
}

interface FileChecks {
    notes: boolean
    s2txt: boolean
    changelog: boolean
}

function checkFiles(cwd: string): FileChecks {
    return {
        notes: existsSync(join(cwd, "NOTES.md")),
        s2txt: existsSync(join(cwd, "S2.txt")),
        changelog: existsSync(join(cwd, "CHANGELOG.md")),
    }
}

interface PassResult {
    auditLog: string
    elapsedSecs: number
    completed: string[]
    failed: string[]
    files: FileChecks
    replanCount: number
}

async function runPass(
    label: string,
    cwd: string,
    prdPath: string,
    withSurgeon: boolean,
): Promise<PassResult> {
    const auditLog = join(cwd, `audit-${label}.jsonl`)
    process.stderr.write(
        `\n[phase4] ──── pass ${label} (withSurgeon=${withSurgeon}) ────\n`,
    )
    const startedAt = Date.now()
    const result = await orchestrate({
        prdPath,
        cwd,
        parallel: 2,
        // Tight per-attempt timeout: just long enough for S1/S3 (simple
        // file create + commit) to pass, but well below the 60s sleep
        // S2 is forced to wait through. S2 reliably hits the timeout
        // and Claude exits non-zero → StoryAgent marks it failed →
        // (with Surgeon) ReplanItem removes it.
        timeoutSecs: 25,
        defaultModel: "sonnet",
        emitTuiEvents: false,
        withGit: true,
        withLibrarian: false,
        withSentry: false,
        withSurgeon,
        // Use deterministic Surgeon (no LLM call) — keeps the demo cheap
        // and makes the differential about the *adaptive-DAG plumbing*,
        // not about Opus's planning skill.
        surgeonUseLlm: false,
        auditLogPath: auditLog,
        extraParticipants: [new LiveLogger(label)],
    })
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    const files = checkFiles(cwd)
    const replanCount = countByType(auditLog, "replan")
    process.stderr.write(
        `[phase4] pass ${label} done in ${elapsed}s — ` +
            `passed=[${result.summary.completedStories.join(",")}] ` +
            `failed=[${result.summary.failedStories.join(",")}] ` +
            `replans=${replanCount}\n`,
    )
    process.stderr.write(
        `[phase4] pass ${label} files: NOTES.md=${files.notes} S2.txt=${files.s2txt} CHANGELOG.md=${files.changelog}\n`,
    )
    return {
        auditLog,
        elapsedSecs: elapsed,
        completed: [...result.summary.completedStories],
        failed: [...result.summary.failedStories],
        files,
        replanCount,
    }
}

async function main(): Promise<void> {
    const repoA = setupRepo()
    process.stderr.write(`[phase4] base repo (control):   ${repoA}\n`)

    // Reuse the same starting state for both passes.
    const repoB = mkdtempSync(join(tmpdir(), "baro-phase4-clone-"))
    execFileSync("cp", ["-R", `${repoA}/.`, repoB])
    process.stderr.write(`[phase4] base repo (treatment): ${repoB}\n`)

    const prdA = join(repoA, "prd.json")
    const prdB = join(repoB, "prd.json")
    writeFileSync(prdA, JSON.stringify(buildPrd(), null, 2) + "\n")
    writeFileSync(prdB, JSON.stringify(buildPrd(), null, 2) + "\n")

    const passA = await runPass("control", repoA, prdA, false)
    const passB = await runPass("treatment", repoB, prdB, true)

    process.stderr.write(`\n[phase4] ──── tally ────\n`)
    process.stderr.write(
        `  control   (no Surgeon):   completed=${passA.completed.join(",") || "(none)"} ` +
            `S3 ran? ${passA.files.changelog} replans=${passA.replanCount}\n`,
    )
    process.stderr.write(
        `  treatment (with Surgeon): completed=${passB.completed.join(",") || "(none)"} ` +
            `S3 ran? ${passB.files.changelog} replans=${passB.replanCount}\n`,
    )

    if (!passA.files.changelog && passB.files.changelog) {
        process.stderr.write(
            `\n[phase4] ✓ Surgeon delivered measurable value: ` +
                `S3 ran in treatment (S2's failure removed by ReplanItem) ` +
                `but not in control.\n`,
        )
    } else if (passA.files.changelog && passB.files.changelog) {
        process.stderr.write(
            `\n[phase4] ⚠ S3 ran in BOTH passes — control's failure-handling ` +
                `was already enough for this scenario; the Surgeon path ran but ` +
                `wasn't strictly required.\n`,
        )
    } else if (!passB.files.changelog) {
        process.stderr.write(
            `\n[phase4] ✗ S3 didn't run in treatment either — Surgeon plumbing ` +
                `may not have applied the replan; check audit log.\n`,
        )
    }

    process.stderr.write(
        `\n[phase4] keep repos for inspection:\n  control:   ${repoA}\n  treatment: ${repoB}\n`,
    )
}

main().catch((e: unknown) => {
    process.stderr.write(`[phase4] fatal: ${(e as Error)?.stack ?? String(e)}\n`)
    process.exit(1)
})
