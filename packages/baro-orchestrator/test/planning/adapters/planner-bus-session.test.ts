import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

import { AgenticEnvironment, BaseObserver } from "../../../src/runtime/mozaik.js"
import { PlanFragmentAdmitted } from "../../../src/semantic-events.js"
import { PROGRESSIVE_PLANNER_MCP_MODE } from "../../../src/planning/adapters/planner-harness-progressive.js"
import {
    goalTextFromEnvelope,
    runPlannerBusSession,
} from "../../../src/planning/adapters/planner-bus-session.js"
import type {
    PlanCompleteCommand,
    PlanFailedCommand,
    PlanFragmentCommand,
    PlanningOpenCommand,
} from "../../../src/stdin-commands.js"
import type { GoalEnvelope } from "../../../src/conversation/session/conversation-contract.js"
import { withTempDir } from "../../execution/helpers.js"

const RUN_PLANNER_ENTRY = fileURLToPath(
    new URL("../../../scripts/run-planner.ts", import.meta.url),
)
const TSX_LOADER = import.meta.resolve("tsx")

const PUBLISHED_STORY = {
    id: "S1",
    priority: 1,
    title: "Open the progressive contract",
    description: "Publish one closed story while planning continues.",
    dependsOn: [],
    retries: 2,
    acceptance: ["The story is visible before the final PRD resolves."],
    tests: ["npm test -- planner-bus-session"],
    goalInvariantIds: [],
    passes: false,
    completedAt: null,
    durationSecs: null,
    model: "heavy",
}

const FINAL_PRD = JSON.stringify({
    project: "baro",
    branchName: "planner-bus-session",
    description: "Exercise the bus planner session.",
    userStories: [
        {
            id: PUBLISHED_STORY.id,
            priority: PUBLISHED_STORY.priority,
            title: PUBLISHED_STORY.title,
            description: PUBLISHED_STORY.description,
            dependsOn: PUBLISHED_STORY.dependsOn,
            retries: PUBLISHED_STORY.retries,
            acceptance: PUBLISHED_STORY.acceptance,
            tests: PUBLISHED_STORY.tests,
            goalInvariantIds: PUBLISHED_STORY.goalInvariantIds,
            model: PUBLISHED_STORY.model,
        },
    ],
})

const ENVELOPE: GoalEnvelope = {
    objective: "Exercise the bus planner session end to end.",
    constraints: ["Publish one fragment before the final PRD."],
    acceptanceCriteria: ["The stub feed records one completion."],
    nonGoals: [],
    assumptions: [],
}

/** Simulates the Board: every proposed fragment is admitted at graph v7
 *  with one pruned edge, so the receipt the model sees is the host's. */
class StubFeed extends BaseObserver {
    readonly opened: PlanningOpenCommand[] = []
    readonly fragments: PlanFragmentCommand[] = []
    readonly completions: PlanCompleteCommand[] = []
    readonly failures: PlanFailedCommand[] = []

    open(command: PlanningOpenCommand): void {
        this.opened.push(command)
    }

    fragment(command: PlanFragmentCommand): void {
        this.fragments.push(command)
        const admitted = PlanFragmentAdmitted.create({
            runId: command.run_id,
            planningId: command.planning_id,
            fragmentId: command.fragment_id,
            ordinal: command.ordinal,
            graphVersion: 7,
            storyIds: command.stories.map((story) => story.id),
            replay: false,
            droppedEdges: ["S9->S1"],
        })
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, admitted)
        }
    }

    complete(command: PlanCompleteCommand): void {
        this.completions.push(command)
    }

    failed(command: PlanFailedCommand): void {
        this.failures.push(command)
    }
}

function writeFakeClaude(dir: string): string {
    const path = join(dir, "fake-bus-claude.mjs")
    writeFileSync(
        path,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const publishedStory = ${JSON.stringify(PUBLISHED_STORY)};
const finalPrd = ${JSON.stringify(FINAL_PRD)};
const argv = process.argv.slice(2);

const configIndex = argv.indexOf("--mcp-config");
if (configIndex < 0) throw new Error("fixture expected --mcp-config");
const config = JSON.parse(argv[configIndex + 1]);
const server = config.mcpServers["baro_planning"];
if (!server || server.type !== "stdio") throw new Error("fixture expected the baro_planning stdio server");
const env = {};
for (const [name, reference] of Object.entries(server.env ?? {})) {
    const expected = String.fromCharCode(36) + "{" + name + "}";
    if (reference !== expected || !process.env[name]) {
        throw new Error("fixture received an invalid inherited MCP environment");
    }
    env[name] = process.env[name];
}

process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "bus-1" }) + "\\n");

// The session writes the planner prompt as the first stdin user event.
const lines = createInterface({ input: process.stdin });
const firstMessage = await new Promise((resolve) => lines.once("line", resolve));
const parsed = JSON.parse(firstMessage);
if (parsed.type !== "user" || typeof parsed.message?.content !== "string") {
    throw new Error("fixture expected a stream-json user event first");
}

await exerciseBaroMcp({ command: server.command, args: server.args, env });

process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: finalPrd,
    session_id: "bus-1",
}) + "\\n");
process.exit(0);

async function exerciseBaroMcp(target) {
    const child = spawn(target.command, target.args, {
        env: { ...process.env, ...target.env },
        stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const pending = new Map();
    let buffer = "";
    const exit = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0 && signal === null) resolve();
            else reject(new Error("MCP child failed: code=" + code + " signal=" + signal + " " + stderr));
        });
    });
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const response = JSON.parse(line);
            const waiter = pending.get(response.id);
            if (!waiter) throw new Error("unexpected MCP response id: " + response.id);
            pending.delete(response.id);
            if (response.error) waiter.reject(new Error(response.error.message));
            else waiter.resolve(response.result);
        }
    });
    const request = (id, method, params = {}) => new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    });

    await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "baro-fake-bus-claude", version: "1.0.0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\\n");
    await request(2, "tools/list");
    const called = await request(3, "tools/call", {
        name: "publish_plan_fragment",
        arguments: { fragmentId: "foundation", stories: [publishedStory] },
    });
    if (called.isError || called.content?.[0]?.type !== "text") {
        throw new Error("publish_plan_fragment failed: " + JSON.stringify(called));
    }
    const receipt = JSON.parse(called.content[0].text);
    // The receipt must be the HOST's admission, not a local echo.
    if (receipt.ok !== true || receipt.graphVersion !== 7) {
        throw new Error("receipt missing authoritative graphVersion: " + called.content[0].text);
    }
    if (!Array.isArray(receipt.droppedEdges) || receipt.droppedEdges[0] !== "S9->S1") {
        throw new Error("receipt missing dropped edges: " + called.content[0].text);
    }
    child.stdin.end();
    await exit;
}
`,
    )
    chmodSync(path, 0o755)
    return path
}

describe("planner bus session", () => {
    it("runs the planner on the bus with authoritative fragment receipts", async () => {
        await withTempDir("baro-planner-bus-", async (dir) => {
            const env = new AgenticEnvironment("planner-bus-session")
            const feed = new StubFeed()
            feed.join(env)

            const result = await runPlannerBusSession({
                runId: "run-bus-1",
                cwd: dir,
                env,
                feed,
                goalEnvelope: ENVELOPE,
                claudeBin: writeFakeClaude(dir),
                mcpServer: {
                    command: process.execPath,
                    args: [
                        "--import",
                        TSX_LOADER,
                        RUN_PLANNER_ENTRY,
                        PROGRESSIVE_PLANNER_MCP_MODE,
                    ],
                },
            })

            assert.deepEqual(feed.failures, [])
            assert.equal(result.status, "completed")
            assert.equal(feed.opened.length, 1)
            assert.equal(feed.fragments.length, 1)
            assert.equal(feed.fragments[0]!.fragment_id, "foundation")
            assert.equal(feed.completions.length, 1)
            const finalPrd = feed.completions[0]!.final_prd as {
                userStories: Array<{ id: string }>
            }
            assert.equal(finalPrd.userStories[0]!.id, "S1")
        })
    })

    it("renders the trusted envelope as the planner goal", () => {
        const text = goalTextFromEnvelope(ENVELOPE)
        assert.match(text, /^Exercise the bus planner session end to end\./)
        assert.match(text, /Constraints:\n- Publish one fragment/)
        assert.match(text, /Acceptance criteria:\n- The stub feed records/)
        assert.doesNotMatch(text, /Non-goals/)
    })
})
