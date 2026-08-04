import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { AgenticEnvironment, BaseObserver } from "../../src/runtime/mozaik.js"
import {
    ScoutDispatched,
    ScoutFindingPublished,
    type SemanticEvent,
} from "../../src/semantic-events.js"
import { runArchitectResearchSession } from "../../src/planning/adapters/architect-research-session.js"
import { withTempDir } from "../execution/helpers.js"

class Capture extends BaseObserver {
    readonly events: SemanticEvent<unknown>[] = []
    override onExternalEvent(_source: unknown, event: SemanticEvent<unknown>): void {
        this.events.push(event)
    }
}

/**
 * A scout whose question contains WAIT answers only after a peer's finding
 * reaches its stdin, and quotes it — so the assertion proves delivery
 * happened mid-read, not that the board merely collected two answers.
 */
function writeFakeClaude(dir: string): string {
    const path = join(dir, "fake-scout-claude.mjs")
    writeFileSync(
        path,
        `#!/usr/bin/env node
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (!argv.includes("--safe-mode")) throw new Error("scouts must run read-only");
const toolsAt = argv.indexOf("--tools");
if (toolsAt < 0 || argv[toolsAt + 1] !== "Read,Glob,Grep") {
    throw new Error("scouts must be restricted to read-only tools");
}

process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "scout" }) + "\\n");

const emit = (text) => process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: "scout",
}) + "\\n");

const lines = createInterface({ input: process.stdin });
let question = null;
for await (const line of lines) {
    const event = JSON.parse(line);
    if (event.type !== "user") continue;
    const content = event.message?.content ?? "";
    if (question === null) {
        question = content;
        if (!content.includes("WAIT")) {
            emit("answered " + content.slice(0, 20) + " (src/a.ts:1)");
        }
        continue;
    }
    // A peer note arrived while this scout was still reading.
    emit("used peer note -> " + content.split("\\n")[0]);
}
process.exit(0);
`,
    )
    chmodSync(path, 0o755)
    return path
}

describe("architect research session", () => {
    it("carries a finding to the scouts still reading", async () => {
        await withTempDir("baro-research-session-", async (dir) => {
            const env = new AgenticEnvironment("research-test")
            const capture = new Capture()
            capture.join(env)

            const findings = await runArchitectResearchSession({
                questions: [
                    { id: "Q1", question: "Which module owns menu visibility?" },
                    { id: "Q2", question: "WAIT for a peer before answering" },
                ],
                cwd: dir,
                claudeBin: writeFakeClaude(dir),
                environment: env,
                roundBudgetMs: 20_000,
            })

            assert.equal(findings.length, 2)
            const waiting = findings.find((finding) => finding.id === "Q2")
            assert.ok(waiting)
            assert.equal(waiting.ok, true)
            assert.match(
                waiting.answer,
                /used peer note -> \[peer Q1\]/u,
                "the waiting scout must answer with what its peer found",
            )

            const dispatched = capture.events.filter(ScoutDispatched.is)
            assert.equal(dispatched.length, 2)
            const published = capture.events.filter(ScoutFindingPublished.is)
            assert.deepEqual(
                published.map((event) => event.data.ok),
                [true, true],
                "every answer reaches the bus as an event",
            )
        })
    })

    it("returns a stated gap when the round budget expires", async () => {
        await withTempDir("baro-research-budget-", async (dir) => {
            const findings = await runArchitectResearchSession({
                questions: [{ id: "Q1", question: "WAIT forever, nobody will answer" }],
                cwd: dir,
                claudeBin: writeFakeClaude(dir),
                roundBudgetMs: 300,
            })
            assert.equal(findings.length, 1)
            assert.equal(findings[0]!.ok, false)
            assert.match(findings[0]!.answer, /unanswered: the research round budget expired/u)
        })
    })

    it("asks nothing when there is nothing to ask", async () => {
        assert.deepEqual(
            await runArchitectResearchSession({ questions: [], cwd: "/tmp" }),
            [],
        )
    })
})
