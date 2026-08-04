import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { AgenticEnvironment, BaseObserver } from "../../src/runtime/mozaik.js"
import {
    ScoutFindingPublished,
    type SemanticEvent,
} from "../../src/semantic-events.js"
import { runArchitectBusSession } from "../../src/planning/adapters/architect-bus-session.js"
import { withTempDir } from "../execution/helpers.js"

class Capture extends BaseObserver {
    readonly events: SemanticEvent<unknown>[] = []
    override onExternalEvent(_source: unknown, event: SemanticEvent<unknown>): void {
        this.events.push(event)
    }
}

/**
 * One fake CLI serving both roles. The Architect asks once, reads the answers
 * it gets back, and only then produces an outcome — first a rejected one, so
 * the correction path is exercised too. Scouts answer their own question.
 */
function writeFakeClaude(dir: string): string {
    const path = join(dir, "fake-architect-claude.mjs")
    writeFileSync(
        path,
        `#!/usr/bin/env node
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const systemAt = argv.indexOf("--system-prompt");
const system = systemAt >= 0 ? argv[systemAt + 1] : "";
const isScout = system.includes("repository scout");

process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\\n");
const emit = (text) => process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: text, session_id: "s",
}) + "\\n");

const lines = createInterface({ input: process.stdin });
let turn = 0;
for await (const line of lines) {
    const event = JSON.parse(line);
    if (event.type !== "user") continue;
    const content = event.message?.content ?? "";
    turn += 1;
    if (isScout) {
        emit("scout answer for: " + content.slice(0, 24) + " (src/x.ts:7)");
        continue;
    }
    if (turn === 1) {
        if (!content.includes("say what you must learn")) {
            throw new Error("the Architect's first turn must be the research turn");
        }
        emit(JSON.stringify({ questions: [
            { question: "Which module owns menu visibility today?" },
            { question: "Where is the pagination convention defined?" },
        ] }));
        continue;
    }
    if (turn === 2) {
        if (!content.includes("scout answer for")) {
            throw new Error("the Architect must receive the scouts' answers");
        }
        // Deliberately invalid: exercises the host's correction path.
        emit("NOT-AN-OUTCOME");
        continue;
    }
    if (!content.includes("rejected")) {
        throw new Error("a rejected outcome must come back as a correction");
    }
    emit(JSON.stringify({ ok: true, saw: "scout answer" }));
}
process.exit(0);
`,
    )
    chmodSync(path, 0o755)
    return path
}

describe("architect bus session", () => {
    it("asks, reads the answers, and repairs a rejected outcome", async () => {
        await withTempDir("baro-architect-bus-", async (dir) => {
            const env = new AgenticEnvironment("architect-bus-test")
            const capture = new Capture()
            capture.join(env)

            const result = await runArchitectBusSession({
                systemPrompt: "You are the architect for this engineering run.",
                userMessage: "Migrate validation to zod.",
                goal: "Migrate validation to zod.",
                cwd: dir,
                claudeBin: writeFakeClaude(dir),
                environment: env,
                roundBudgetMs: 20_000,
                validateOutcome: (raw) => {
                    const parsed = JSON.parse(raw) as { ok?: unknown }
                    if (parsed.ok !== true) throw new Error("outcome must state ok:true")
                },
            })

            assert.equal(result.researchRounds, 1)
            assert.equal(result.outcomeAttempts, 2, "the rejected outcome was repaired")
            assert.equal(result.findings.length, 2)
            assert.ok(result.findings.every((finding) => finding.ok))
            assert.match(result.outcome, /"saw":"scout answer"/)

            const published = capture.events.filter(ScoutFindingPublished.is)
            assert.equal(
                published.length,
                2,
                "the Architect's research is on the same bus, as events",
            )
        })
    })

    it("goes straight to the outcome when the Architect asks nothing", async () => {
        await withTempDir("baro-architect-bus-direct-", async (dir) => {
            const path = join(dir, "silent-claude.mjs")
            writeFileSync(
                path,
                `#!/usr/bin/env node
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
    const event = JSON.parse(line);
    if (event.type !== "user") continue;
    process.stdout.write(JSON.stringify({
        type: "result", subtype: "success", is_error: false,
        result: JSON.stringify({ ok: true }), session_id: "s",
    }) + "\\n");
}
process.exit(0);
`,
            )
            chmodSync(path, 0o755)

            const result = await runArchitectBusSession({
                systemPrompt: "architect",
                userMessage: "Small fix.",
                goal: "Small fix.",
                cwd: dir,
                claudeBin: path,
                validateOutcome: (raw) => {
                    if ((JSON.parse(raw) as { ok?: unknown }).ok !== true) {
                        throw new Error("outcome must state ok:true")
                    }
                },
            })
            assert.equal(result.researchRounds, 0)
            assert.equal(result.findings.length, 0)
            assert.equal(result.outcomeAttempts, 1)
        })
    })
})
