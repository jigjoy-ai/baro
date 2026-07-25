#!/usr/bin/env node
// Split the suite into a fast lane (in-memory tests, higher concurrency)
// and a slow lane (spawn/CLI/process-tree tests, conservative concurrency).
// `npm test` stays the single full-suite gate; lanes are the dev loop.
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"

const SLOW_PATTERNS = [
    "test/harness/",
    "test/planning/adapters/",
    "test/integration/",
    "test/execution/story-executor",
    "test/acceptance/critic-evidence",
    "test/goal/goal-invariant-reviewer",
    "test/goal/goal-aggregate-governance",
    "test/conversation/dialogue-responder",
    "test/conversation/session/process-session-host",
    "test/verification/verify",
    "orchestrate",
    "scripts-smoke",
    "progressive-cli-smoke",
    "story-tool-containment",
    "run-architect-outcome",
    "run-conversation-script",
    "runner-protocol",
    "runner-helpers",
    "agent-collab",
    "ab-evidence",
]

function walk(dir) {
    const files = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) files.push(...walk(path))
        else if (entry.name.endsWith(".test.ts")) files.push(path)
    }
    return files
}

const lane = process.argv[2]
if (lane !== "fast" && lane !== "slow") {
    console.error("usage: test-lanes.mjs <fast|slow>")
    process.exit(2)
}

const all = walk("test")
const slow = all.filter((file) =>
    SLOW_PATTERNS.some((pattern) => file.includes(pattern)),
)
const files = lane === "slow" ? slow : all.filter((f) => !slow.includes(f))
const concurrency = lane === "slow" ? "2" : "4"

console.error(`[test-lanes] ${lane}: ${files.length}/${all.length} files, concurrency ${concurrency}`)
const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...files.sort()],
    { stdio: "inherit" },
)
process.exit(result.status ?? 1)
