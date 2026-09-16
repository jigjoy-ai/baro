import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, it } from "node:test"

import { withTempDir } from "./execution/helpers.js"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const RUN_ARCHITECT = join(
    REPO_ROOT,
    "packages/baro-orchestrator/scripts/run-architect.ts",
)

const GAP_LINE =
    /awake-clock: absorbed (\d+)ms suspension gap \(budget=([^)]+)\)/gu

const SUSPENDED_MS = 4 * 60 * 60 * 1_000
const PHASE_BUDGET_MS = 4_000

const DECISION_DOCUMENT = `## Existing context
The fixture repository has one provider-neutral contract.

## ADR-001: Keep the fixture stable
**Status:** Accepted
**Context:** The test requires a valid decision document.
**Decision:** Preserve the strict outcome boundary.
**Consequences:** Provider prose cannot cross the boundary.`

interface ScriptResult {
    code: number | null
    stdout: string
    stderr: string
}

describe("run-architect awake phase budget", () => {
    it("absorbs a machine suspend inside the budget and names it once on stderr", async () => {
        await withTempDir("baro-architect-awake-absorb-", async (dir) => {
            const marker = join(dir, "suspend-marker")
            const binary = writePhasedFakeCodex(dir, {
                obligationDelayMs: 300,
                markerFile: marker,
            })
            const run = await runArchitect(dir, [
                "--codex-bin", binary,
                "--timeout-ms", String(PHASE_BUDGET_MS),
            ], writeSuspendPreload(dir, marker))

            assert.equal(run.code, 0, run.stderr)
            assert.equal(existsSync(join(dir, "outcome.json")), true, run.stderr)
            assert.doesNotMatch(run.stderr, /phase budget/u)

            const gaps = [...run.stderr.matchAll(GAP_LINE)]
            assert.equal(gaps.length, 1, run.stderr)
            assert.ok(
                Number(gaps[0]![1]) >= SUSPENDED_MS,
                `gap duration ${gaps[0]![1]}ms must name the whole suspend`,
            )
            assert.equal(gaps[0]![2], "architect-obligations")

            const events = gapEvents(run.stdout)
            assert.equal(events.length, 1, run.stdout)
            assert.ok(events[0]!.gap_ms >= SUSPENDED_MS)
            assert.equal(
                events[0]!.budget,
                gaps[0]![2],
                "the event must name the same budget as its stderr twin",
            )
        })
    })

    it("still trips the shared phase budget at the same awake elapsed", async () => {
        await withTempDir("baro-architect-awake-trip-", async (dir) => {
            const binary = writePhasedFakeCodex(dir, {
                obligationDelayMs: 8_000,
            })
            const run = await runArchitect(dir, [
                "--codex-bin", binary,
                "--timeout-ms", String(PHASE_BUDGET_MS),
            ])

            assert.notEqual(run.code, 0, run.stderr)
            assert.match(run.stderr, /shared 4000ms phase budget/u)
            assert.equal(existsSync(join(dir, "outcome.json")), false)
            // A host that never sleeps must stay byte-identical to today.
            assert.doesNotMatch(run.stderr, /awake-clock:/u)
            assert.equal(gapEvents(run.stdout).length, 0)
        })
    })
})

interface GapEvent {
    type: "suspension_gap_absorbed"
    gap_ms: number
}

function gapEvents(stdout: string): GapEvent[] {
    return stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type?: unknown })
        .filter((event): event is GapEvent =>
            event.type === "suspension_gap_absorbed"
        )
}

/**
 * A real child cannot be suspended, so wall time is shifted ahead of the
 * monotonic clock the awake clock compares it against — the same divergence
 * a laptop sleep produces. The marker file keys the shift to the obligation
 * phase, so it always lands after that deadline is armed.
 */
function writeSuspendPreload(dir: string, markerFile: string): string {
    const path = join(dir, "suspend-preload.mjs")
    writeFileSync(path, `
import { existsSync } from "node:fs";
const realNow = Date.now;
let shifted = false;
let lastCheckMs = 0;
Date.now = () => {
  const now = realNow();
  if (!shifted && now - lastCheckMs >= 20) {
    lastCheckMs = now;
    shifted = existsSync(${JSON.stringify(markerFile)});
  }
  return shifted ? now + ${SUSPENDED_MS} : now;
};
`)
    return path
}

function writePhasedFakeCodex(
    dir: string,
    options: { obligationDelayMs: number; markerFile?: string },
): string {
    const ready = {
        schemaVersion: 1,
        kind: "ready",
        message: "Repository validation is complete.",
        questions: [],
        evidence: [],
        constraintPredicates: [],
        decisionDocument: DECISION_DOCUMENT,
    }
    const segment = {
        schemaVersion: 1,
        obligations: [{
            adrIds: ["ADR-001"],
            invariantIds: ["G-A1"],
            subject: "the strict outcome boundary",
            scenario: "the validated goal advances to planning",
            expectedOutcome: "the repository validation remains observable",
            evidence: ["a focused outcome transport test"],
        }],
    }
    const path = join(dir, "fake-phased-codex.mjs")
    writeFileSync(path, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("-")) { for await (const chunk of process.stdin) void chunk; }
const decisionPhase = argv.includes("--output-schema");
const payload = decisionPhase ? ${JSON.stringify(ready)} : ${JSON.stringify(segment)};
${options.markerFile === undefined ? "" : `if (!decisionPhase) writeFileSync(${JSON.stringify(options.markerFile)}, "");`}
setTimeout(() => {
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
}, decisionPhase ? 0 : ${options.obligationDelayMs});
`)
    chmodSync(path, 0o755)
    return path
}

function runArchitect(
    dir: string,
    backendArgs: string[],
    preload?: string,
): Promise<ScriptResult> {
    const goalEnvelopeFile = join(dir, "goal-envelope.json")
    writeFileSync(goalEnvelopeFile, JSON.stringify({
        objective: "Validate the candidate goal against the repository",
        acceptanceCriteria: ["Repository validation is complete."],
        constraints: [],
        nonGoals: [],
        assumptions: [],
    }))
    return runScript([
        ...(preload ? ["--import", preload] : []),
        RUN_ARCHITECT,
        "--goal", "Validate the candidate goal against the repository",
        "--cwd", dir,
        "--llm", "codex",
        ...backendArgs,
        "--outcome-file", join(dir, "outcome.json"),
        "--goal-envelope-file", goalEnvelopeFile,
        "--conversation-session-id", "session-trusted",
        "--goal-request-id", "goal-request-trusted",
        "--architect-request-id", "architect-request-trusted",
    ])
}

function runScript(args: string[]): Promise<ScriptResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ["--import", "tsx", ...args],
            {
                cwd: REPO_ROOT,
                env: { ...process.env, BARO_ARCHITECT_BUS: "0" },
                stdio: ["ignore", "pipe", "pipe"],
            },
        )
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk
        })
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk
        })
        child.on("error", reject)
        child.on("exit", (code) => resolve({ code, stdout, stderr }))
    })
}
