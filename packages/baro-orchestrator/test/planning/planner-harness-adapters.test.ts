import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { promisify } from "node:util"

import {
    runClaudeIntake,
    runPlannerClaude,
} from "../../src/planning/planner-claude.js"
import {
    runCodexIntake,
    runPlannerCodex,
} from "../../src/planning/planner-codex.js"
import { PROGRESSIVE_PLANNER_MCP_MODE } from "../../src/planning/planner-harness-progressive.js"
import type { PlannerOpenAIPlanFragmentEvent } from "../../src/planning/planner-openai-progressive.js"
import type { ModeContract } from "../../src/planning/planner-prompts.js"
import { withTempDir } from "../participants/helpers.js"

const RUN_PLANNER_ENTRY = fileURLToPath(
    new URL("../../scripts/run-planner.ts", import.meta.url),
)
const TSX_LOADER = import.meta.resolve("tsx")
const execFileAsync = promisify(execFile)

const PARALLEL_MODE: ModeContract = {
    mode: "parallel",
    confidence: 1,
    reason: "deterministic harness adapter fixture",
    source: "user",
}

const FOCUSED_MODE: ModeContract = {
    mode: "focused",
    confidence: 1,
    reason: "deterministic one-story process fixture",
    maxStories: 1,
    parallelism: 1,
    source: "user",
}

const PUBLISHED_STORY = {
    id: "S1",
    priority: 1,
    title: "Open the progressive contract",
    description: "Publish one closed story while planning continues.",
    dependsOn: [],
    retries: 2,
    acceptance: ["The story is visible before the final PRD resolves."],
    tests: ["npm test -- planner-harness-adapters"],
    passes: false,
    completedAt: null,
    durationSecs: null,
    model: "heavy",
}

const FINAL_PRD = JSON.stringify({
    project: "baro",
    branchName: "progressive-harness-adapters",
    description: "Exercise progressive planner harness adapters.",
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
            model: PUBLISHED_STORY.model,
        },
    ],
})

type Harness = "claude" | "codex"

describe("subscription planner progressive harness adapters", () => {
    for (const harness of ["claude", "codex"] as const) {
        it(`${harness} starts the configured Baro MCP child and publishes before final resolution`, async () => {
            await withTempDir(`baro-${harness}-progressive-`, async (dir) => {
                const argvFile = join(dir, `${harness}-argv.json`)
                const harnessBin = writeFakeHarness(dir, harness, argvFile)
                const fragments: PlannerOpenAIPlanFragmentEvent[] = []
                let releasePublish!: () => void
                let markPublishEntered!: () => void
                const publishGate = new Promise<void>((resolve) => {
                    releasePublish = resolve
                })
                const publishEntered = new Promise<void>((resolve) => {
                    markPublishEntered = resolve
                })
                let plannerSettled = false

                const plannerPromise = runHarness(harness, {
                    dir,
                    harnessBin,
                    progressive: {
                        runId: `run-${harness}`,
                        planningId: `planning-${harness}`,
                        mcpServer: actualBaroMcpCommand(),
                        publish: async (event) => {
                            fragments.push(event)
                            markPublishEntered()
                            await publishGate
                        },
                    },
                })
                void plannerPromise.then(
                    () => {
                        plannerSettled = true
                    },
                    () => {
                        plannerSettled = true
                    },
                )

                await Promise.race([
                    publishEntered,
                    plannerPromise.then(
                        () => {
                            throw new Error(
                                "planner resolved before publishing its fixture fragment",
                            )
                        },
                        (error: unknown) => {
                            throw error
                        },
                    ),
                ])
                assert.equal(
                    plannerSettled,
                    false,
                    "the fragment callback must run while the planner is still active",
                )
                assert.deepEqual(fragments, [
                    {
                        type: "plan_fragment",
                        run_id: `run-${harness}`,
                        planning_id: `planning-${harness}`,
                        fragment_id: "foundation",
                        ordinal: 1,
                        stories: [PUBLISHED_STORY],
                    },
                ])

                releasePublish()
                const result = await plannerPromise
                assert.deepEqual(JSON.parse(result), JSON.parse(FINAL_PRD))

                const argv = readArgv(argvFile)
                if (harness === "claude") {
                    assert.ok(argv.includes("--strict-mcp-config"))
                    for (const flag of [
                        "--setting-sources",
                        "--disable-slash-commands",
                        "--no-session-persistence",
                        "--allowed-tools",
                    ]) assert.ok(argv.includes(flag), `missing Claude flag ${flag}`)
                    assert.equal(argv.includes("--safe-mode"), false)
                    const settingSources = argv.indexOf("--setting-sources")
                    assert.equal(argv[settingSources + 1], "")
                    assert.equal(argv.includes("bypassPermissions"), false)
                    assert.ok(argv.includes("dontAsk"))
                    const configIndex = argv.indexOf("--mcp-config")
                    assert.notEqual(configIndex, -1)
                    const config = JSON.parse(argv[configIndex + 1]!) as {
                        mcpServers?: Record<string, unknown>
                    }
                    assert.deepEqual(Object.keys(config.mcpServers ?? {}), [
                        "baro_planning",
                    ])
                    const server = config.mcpServers?.baro_planning as {
                        env?: Record<string, string>
                    }
                    assert.deepEqual(server.env, {
                        BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN:
                            "${BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN}",
                    })
                    assert.doesNotMatch(argv[configIndex + 1]!, /[a-f0-9]{64}/u)
                } else {
                    assert.ok(argv.includes("--strict-config"))
                    assert.equal(
                        argv.includes("--dangerously-bypass-approvals-and-sandbox"),
                        false,
                    )
                    for (const flag of [
                        "--ephemeral",
                        "--ignore-user-config",
                        "--ignore-rules",
                    ]) assert.ok(argv.includes(flag), `missing Codex flag ${flag}`)
                    const sandbox = argv.indexOf("--sandbox")
                    assert.notEqual(sandbox, -1)
                    assert.equal(argv[sandbox + 1], "read-only")
                    assert.ok(argv.includes("hooks"))
                    assert.ok(argv.includes('approval_policy="never"'))
                    assert.ok(argv.includes('web_search="disabled"'))
                    assert.ok(
                        argv.some((value) =>
                            value.startsWith("projects={") &&
                            value.endsWith('={trust_level="untrusted"}}'),
                        ),
                    )
                    const overrides = codexMcpOverrides(argv)
                    assert.equal(overrides.length, 1)
                    assert.match(
                        overrides[0]!,
                        /env_vars=\["BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN"\]/u,
                    )
                    assert.doesNotMatch(overrides[0]!, /[a-f0-9]{64}/u)
                    assert.ok(
                        argv.includes(
                            'shell_environment_policy.exclude=["BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN"]',
                        ),
                    )
                }
            })
        })

        it(`${harness} intake is isolated and cannot ask or mutate`, async () => {
            await withTempDir(`baro-${harness}-intake-safe-`, async (dir) => {
                const argvFile = join(dir, `${harness}-intake-argv.json`)
                const harnessBin = writeFakeHarness(dir, harness, argvFile)
                const options = {
                    goal: "Classify this task without touching the checkout.",
                    cwd: dir,
                    timeoutMs: 30_000,
                }

                if (harness === "claude") {
                    await runClaudeIntake({ ...options, claudeBin: harnessBin })
                } else {
                    await runCodexIntake({ ...options, codexBin: harnessBin })
                }

                const argv = readArgv(argvFile)
                if (harness === "claude") {
                    for (const flag of [
                        "--safe-mode",
                        "--disable-slash-commands",
                        "--no-session-persistence",
                        "--strict-mcp-config",
                    ]) assert.ok(argv.includes(flag), `missing Claude intake ${flag}`)
                    assert.equal(argv.includes("bypassPermissions"), false)
                    assert.ok(argv.includes("dontAsk"))
                    const tools = argv.indexOf("--tools")
                    assert.notEqual(tools, -1)
                    assert.equal(argv[tools + 1], "")
                } else {
                    assert.equal(
                        argv.includes("--dangerously-bypass-approvals-and-sandbox"),
                        false,
                    )
                    for (const flag of [
                        "--ephemeral",
                        "--ignore-user-config",
                        "--ignore-rules",
                        "--strict-config",
                    ]) assert.ok(argv.includes(flag), `missing Codex intake ${flag}`)
                    assert.ok(argv.includes('default_permissions="baro_dialogue"'))
                    assert.ok(argv.includes("project_doc_max_bytes=0"))
                    assert.ok(argv.includes("hooks"))
                }
            })
        })

        it(`${harness} preserves the final-only invocation when progressive planning is absent`, async () => {
            await withTempDir(`baro-${harness}-legacy-`, async (dir) => {
                const argvFile = join(dir, `${harness}-argv.json`)
                const harnessBin = writeFakeHarness(dir, harness, argvFile)

                const result = await runHarness(harness, { dir, harnessBin })

                assert.deepEqual(JSON.parse(result), JSON.parse(FINAL_PRD))
                const argv = readArgv(argvFile)
                if (harness === "claude") {
                    assert.equal(argv.includes("--strict-mcp-config"), false)
                    assert.equal(argv.includes("--mcp-config"), false)
                } else {
                    assert.equal(codexMcpOverrides(argv).length, 0)
                }
            })
        })

        it(`${harness} run-planner emits open, fragment, then complete`, async () => {
            await withTempDir(`baro-${harness}-planner-entry-`, async (dir) => {
                const argvFile = join(dir, `${harness}-entry-argv.json`)
                writeFakeHarness(dir, harness, argvFile, harness)
                const bootstrapFile = join(dir, "bootstrap.json")
                const modeFile = join(dir, "mode.json")
                const resultFile = join(dir, "result.json")
                writeFileSync(
                    bootstrapFile,
                    JSON.stringify({
                        project: "baro-entry-test",
                        branchName: "baro/progressive-entry-test",
                        description: "Exercise the complete planner process lane.",
                    }),
                )
                writeFileSync(modeFile, JSON.stringify(FOCUSED_MODE))

                const result = await execFileAsync(
                    process.execPath,
                    [
                        "--import",
                        TSX_LOADER,
                        RUN_PLANNER_ENTRY,
                        "--goal",
                        "Publish a safe story before planning completes.",
                        "--cwd",
                        dir,
                        "--llm",
                        harness,
                        "--mode-file",
                        modeFile,
                        "--result-file",
                        resultFile,
                        "--progressive-run-id",
                        `run-entry-${harness}`,
                        "--progressive-planning-id",
                        `planning-entry-${harness}`,
                        "--progressive-bootstrap-file",
                        bootstrapFile,
                    ],
                    {
                        cwd: dir,
                        timeout: 30_000,
                        env: {
                            ...process.env,
                            PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
                        },
                    },
                )

                const events = result.stdout
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line) as Record<string, unknown>)
                assert.deepEqual(
                    events.map((event) => event.type),
                    ["planning_open", "plan_fragment", "plan_complete"],
                )
                assert.equal(events[1]!.run_id, `run-entry-${harness}`)
                assert.equal(events[1]!.planning_id, `planning-entry-${harness}`)
                assert.deepEqual(
                    JSON.parse(readFileSync(resultFile, "utf8")),
                    events[2]!.final_prd,
                )
            })
        })
    }
})

interface RunHarnessFixtureOptions {
    dir: string
    harnessBin: string
    progressive?: Parameters<typeof runPlannerClaude>[0]["progressive"]
}

function runHarness(
    harness: Harness,
    options: RunHarnessFixtureOptions,
): Promise<string> {
    const shared = {
        goal: "Prove that a safe story can start before planning completes.",
        cwd: options.dir,
        modeContract: PARALLEL_MODE,
        timeoutMs: 30_000,
        ...(options.progressive ? { progressive: options.progressive } : {}),
    }
    return harness === "claude"
        ? runPlannerClaude({ ...shared, claudeBin: options.harnessBin })
        : runPlannerCodex({ ...shared, codexBin: options.harnessBin })
}

function actualBaroMcpCommand() {
    return {
        command: process.execPath,
        args: [
            "--import",
            TSX_LOADER,
            RUN_PLANNER_ENTRY,
            PROGRESSIVE_PLANNER_MCP_MODE,
        ],
    }
}

function readArgv(path: string): string[] {
    return JSON.parse(readFileSync(path, "utf8")) as string[]
}

function codexMcpOverrides(argv: readonly string[]): string[] {
    const values: string[] = []
    for (let index = 0; index < argv.length - 1; index++) {
        if (argv[index] === "--config" && argv[index + 1]!.startsWith("mcp_servers=")) {
            values.push(argv[index + 1]!)
        }
    }
    return values
}

function writeFakeHarness(
    dir: string,
    harness: Harness,
    argvFile: string,
    executableName = `fake-${harness}.mjs`,
): string {
    const path = join(dir, executableName)
    writeFileSync(
        path,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";

const harness = ${JSON.stringify(harness)};
const argvFile = ${JSON.stringify(argvFile)};
const finalPrd = ${JSON.stringify(FINAL_PRD)};
const publishedStory = ${JSON.stringify(PUBLISHED_STORY)};
const { writeFileSync } = await import("node:fs");
writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)));

const server = harness === "claude"
    ? claudeMcpServer(process.argv.slice(2))
    : codexMcpServer(process.argv.slice(2));
if (server) await exerciseBaroMcp(server);

if (harness === "claude") {
    process.stdout.write(JSON.stringify({ result: finalPrd }) + "\\n");
} else {
    process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: finalPrd },
    }) + "\\n");
}

function claudeMcpServer(argv) {
    const index = argv.indexOf("--mcp-config");
    if (index < 0) return null;
    const config = JSON.parse(required(argv[index + 1], "Claude MCP config"));
    const names = Object.keys(config.mcpServers ?? {});
    if (names.length === 0) return null;
    if (names.length !== 1 || names[0] !== "baro_planning") {
        throw new Error("Claude fixture expected only the Baro planning MCP server");
    }
    const server = config.mcpServers[names[0]];
    if (server.type !== "stdio") throw new Error("Claude MCP server must use stdio");
    const env = {};
    for (const [name, reference] of Object.entries(server.env ?? {})) {
        const expectedReference = String.fromCharCode(36) + "{" + name + "}";
        if (reference !== expectedReference || !process.env[name]) {
            throw new Error("Claude fixture received an invalid inherited MCP environment");
        }
        env[name] = process.env[name];
    }
    return { command: server.command, args: server.args, env };
}

function codexMcpServer(argv) {
    const configs = [];
    for (let index = 0; index < argv.length - 1; index++) {
        if (argv[index] === "--config" && argv[index + 1].startsWith("mcp_servers=")) {
            configs.push(argv[index + 1]);
        }
    }
    if (configs.length === 0) return null;
    if (configs.length !== 1 || !configs[0].startsWith("mcp_servers={baro_planning={")) {
        throw new Error("Codex fixture expected one isolated Baro MCP override");
    }
    const command = jsonValueAfter(configs[0], "command=");
    const args = jsonValueAfter(configs[0], "args=");
    const envVars = jsonValueAfter(configs[0], "env_vars=");
    const env = {};
    for (const name of envVars) {
        if (typeof name !== "string" || !process.env[name]) {
            throw new Error("Codex fixture received an invalid inherited MCP environment");
        }
        env[name] = process.env[name];
    }
    const enabledTools = jsonValueAfter(configs[0], "enabled_tools=");
    if (!Array.isArray(args) || enabledTools.join(",") !== "publish_plan_fragment") {
        throw new Error("Codex fixture received the wrong progressive MCP tool surface");
    }
    return { command, args, env };
}

function tomlStringMapAfter(source, marker) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) throw new Error("missing Codex MCP value: " + marker);
    const start = markerIndex + marker.length;
    if (source[start] !== "{") throw new Error("invalid Codex MCP env map");
    const end = source.indexOf("},required=", start);
    if (end < 0) throw new Error("unterminated Codex MCP env map");
    const body = source.slice(start + 1, end);
    if (!body) return {};
    const result = {};
    for (const pair of body.split(",")) {
        const equals = pair.indexOf("=");
        if (equals < 1) throw new Error("invalid Codex MCP env entry");
        const key = pair.slice(0, equals);
        result[key] = JSON.parse(pair.slice(equals + 1));
    }
    return result;
}

function jsonValueAfter(source, marker) {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) throw new Error("missing Codex MCP value: " + marker);
    const start = markerIndex + marker.length;
    if (source[start] === "\\\"") {
        let escaped = false;
        for (let index = start + 1; index < source.length; index++) {
            const char = source[index];
            if (!escaped && char === "\\\"") return JSON.parse(source.slice(start, index + 1));
            if (!escaped && char === "\\\\") escaped = true;
            else escaped = false;
        }
    }
    if (source[start] === "[") {
        let inString = false;
        let escaped = false;
        for (let index = start + 1; index < source.length; index++) {
            const char = source[index];
            if (inString) {
                if (!escaped && char === "\\\"") inString = false;
                if (!escaped && char === "\\\\") escaped = true;
                else escaped = false;
            } else if (char === "\\\"") {
                inString = true;
            } else if (char === "]") {
                return JSON.parse(source.slice(start, index + 1));
            }
        }
    }
    throw new Error("invalid Codex MCP JSON-compatible value: " + marker);
}

async function exerciseBaroMcp(server) {
    if (typeof server.command !== "string" || !Array.isArray(server.args)) {
        throw new Error("fixture received an invalid MCP command");
    }
    const child = spawn(server.command, server.args, {
        env: { ...process.env, ...(server.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const pending = new Map();
    let buffer = "";
    let childError = null;
    const exit = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0 && signal === null) resolve();
            else reject(new Error("Baro MCP child failed: code=" + code + " signal=" + signal + " " + stderr));
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

    const initialized = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "baro-fake-harness", version: "1.0.0" },
    });
    if (initialized.serverInfo?.name !== "baro-progressive-planner") {
        throw new Error("fixture initialized the wrong MCP server");
    }
    child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
    }) + "\\n");
    const listed = await request(2, "tools/list");
    if (listed.tools?.length !== 1 || listed.tools[0].name !== "publish_plan_fragment") {
        throw new Error("fixture did not receive the progressive planning tool");
    }
    const called = await request(3, "tools/call", {
        name: "publish_plan_fragment",
        arguments: { fragmentId: "foundation", stories: [publishedStory] },
    });
    if (called.isError || called.content?.[0]?.type !== "text") {
        throw new Error("publish_plan_fragment failed: " + JSON.stringify(called));
    }
    const receipt = JSON.parse(called.content[0].text);
    if (receipt.ok !== true || receipt.ordinal !== 1 || receipt.fragmentId !== "foundation") {
        throw new Error("invalid progressive publication receipt");
    }
    child.stdin.end();
    await exit;
}

function required(value, label) {
    if (typeof value !== "string" || !value) throw new Error("missing " + label);
    return value;
}
`,
    )
    chmodSync(path, 0o755)
    return path
}
