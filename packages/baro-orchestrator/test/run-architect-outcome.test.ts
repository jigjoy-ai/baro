import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
    chmodSync,
    existsSync,
    readFileSync,
    writeFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { describe, it } from "node:test"

import { withTempDir } from "./participants/helpers.js"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const RUN_ARCHITECT = join(
    REPO_ROOT,
    "packages/baro-orchestrator/scripts/run-architect.ts",
)
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx")

const DECISION_DOCUMENT = `## Existing context
The fixture repository has one provider-neutral contract.

## ADR-001: Keep the fixture stable
**Status:** Accepted
**Context:** The test requires a valid decision document.
**Decision:** Preserve the strict outcome boundary.
**Consequences:** Provider prose cannot cross the boundary.`

const NEEDS_INPUT = {
    schemaVersion: 1,
    kind: "needsInput",
    message: "One repository-backed compatibility choice needs input.",
    questions: [{
        id: "compatibility",
        text: "Must the legacy wire contract remain compatible?",
        reason: "Both public versions are present.",
    }],
    evidence: [{
        path: "src/protocol.ts",
        line: 12,
        fact: "The public v1 serializer remains exported.",
    }],
    decisionDocument: null,
} as const

interface ScriptResult {
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
}

describe("run-architect ArchitectOutcomeV1 mode", () => {
    it("wraps fake Claude output with trusted correlation and read-only flags", async () => {
        await withTempDir("baro-architect-outcome-claude-", async (dir) => {
            const capture = join(dir, "claude-capture.json")
            const binary = writeFakeClaude(dir, NEEDS_INPUT, capture)
            const run = await runArchitect(dir, "claude", ["--claude-bin", binary])

            assert.equal(run.code, 0, run.stderr)
            assert.equal(run.stdout, "")
            assertTransport(dir)

            const argv = readJson<string[]>(capture)
            assert.equal(valueAfter(argv, "--tools"), "Read,Glob,Grep")
            assert.equal(valueAfter(argv, "--permission-mode"), "dontAsk")
            assert.ok(argv.includes("--safe-mode"))
            assert.ok(argv.includes("--no-session-persistence"))
            assert.ok(argv.includes("--json-schema"))
            assert.equal(argv.includes("bypassPermissions"), false)
            assert.match(valueAfter(argv, "--system-prompt"), /PRE-ACCEPTANCE VALIDATION/)
        })
    })

    it("invokes fake Codex with native schema, read-only sandbox and no bypass", async () => {
        await withTempDir("baro-architect-outcome-codex-", async (dir) => {
            const capture = join(dir, "codex-capture.json")
            const binary = writeFakeCodex(dir, NEEDS_INPUT, capture)
            const run = await runArchitect(dir, "codex", ["--codex-bin", binary])

            assert.equal(run.code, 0, run.stderr)
            assertTransport(dir)
            const captured = readJson<{ argv: string[]; schema: unknown }>(capture)
            assert.equal(valueAfter(captured.argv, "--sandbox"), "read-only")
            assert.ok(captured.argv.includes("--ephemeral"))
            assert.ok(captured.argv.includes("--ignore-user-config"))
            assert.ok(captured.argv.includes("--ignore-rules"))
            assert.ok(captured.argv.includes("--strict-config"))
            assert.equal(
                valueAfter(captured.argv, "--config"),
                "project_doc_max_bytes=0",
            )
            assert.ok(captured.argv.includes("--output-schema"))
            assert.equal(
                captured.argv.includes("--dangerously-bypass-approvals-and-sandbox"),
                false,
            )
            assert.equal((captured.schema as { additionalProperties?: unknown }).additionalProperties, false)
            const questionItems = (captured.schema as {
                properties?: {
                    questions?: {
                        items?: { required?: unknown }
                    }
                }
            }).properties?.questions?.items
            assert.deepEqual(questionItems?.required, ["id", "text", "reason"])
            assert.match(captured.argv.at(-1) ?? "", /PRE-ACCEPTANCE VALIDATION/)
        })
    })

    it("runs OpenCode and Pi pre-acceptance in isolated no-tool evaluators", async () => {
        for (const backend of ["opencode", "pi"] as const) {
            await withTempDir(`baro-architect-outcome-${backend}-`, async (dir) => {
                const capture = join(dir, `${backend}-capture.json`)
                const binary = backend === "opencode"
                    ? writeFakeOpenCode(dir, NEEDS_INPUT, capture)
                    : writeFakePi(dir, NEEDS_INPUT, capture)
                const run = await runArchitect(dir, backend, [
                    backend === "opencode" ? "--opencode-bin" : "--pi-bin",
                    binary,
                ])

                assert.equal(run.code, 0, run.stderr)
                assertTransport(dir)
                const captured = readJson<{
                    argv: string[]
                    cwd: string
                    input: string
                    configContent?: string
                }>(capture)
                assert.notEqual(captured.cwd, dir)
                assert.equal(existsSync(captured.cwd), false)
                assert.match(captured.input, /Validate the candidate goal/)
                if (backend === "opencode") {
                    assert.ok(captured.argv.includes("--pure"))
                    assert.equal(valueAfter(captured.argv, "--agent"), "baro-critic")
                    assert.equal(
                        captured.argv.includes("--dangerously-skip-permissions"),
                        false,
                    )
                    const config = JSON.parse(captured.configContent ?? "{}") as {
                        agent?: Record<string, {
                            prompt?: string
                            permission?: Record<string, string>
                            tools?: Record<string, boolean>
                        }>
                    }
                    const safeAgent = config.agent?.["baro-critic"]
                    assert.match(safeAgent?.prompt ?? "", /PRE-ACCEPTANCE VALIDATION/)
                    assert.equal(safeAgent?.permission?.["*"], "deny")
                    assert.ok(
                        Object.values(safeAgent?.tools ?? {}).every(
                            (enabled) => !enabled,
                        ),
                    )
                } else {
                    for (const flag of [
                        "--no-tools",
                        "--no-extensions",
                        "--no-skills",
                        "--no-prompt-templates",
                        "--no-themes",
                        "--no-context-files",
                    ]) assert.ok(captured.argv.includes(flag), `missing ${flag}`)
                    assert.match(
                        valueAfter(captured.argv, "--system-prompt"),
                        /PRE-ACCEPTANCE VALIDATION/,
                    )
                }
            })
        }
    })

    it("fails closed before writing transport when a provider forges authority", async () => {
        await withTempDir("baro-architect-outcome-forged-", async (dir) => {
            const forged = { ...NEEDS_INPUT, sessionId: "model-session" }
            const binary = writeFakeClaude(dir, forged, join(dir, "capture.json"))
            const run = await runArchitect(dir, "claude", ["--claude-bin", binary])

            assert.notEqual(run.code, 0)
            assert.match(run.stderr, /exact v1 schema/)
            assert.equal(existsSync(join(dir, "outcome.json")), false)
        })
    })

    it("keeps legacy --result-file markdown behavior unchanged", async () => {
        await withTempDir("baro-architect-legacy-", async (dir) => {
            const capture = join(dir, "legacy-capture.json")
            const binary = writeFakeClaudeRaw(dir, DECISION_DOCUMENT, capture)
            const resultFile = join(dir, "legacy.md")
            const run = await runScript([
                "--goal", "Keep legacy output",
                "--cwd", dir,
                "--llm", "claude",
                "--claude-bin", binary,
                "--result-file", resultFile,
            ])

            assert.equal(run.code, 0, run.stderr)
            assert.equal(readFileSync(resultFile, "utf8"), DECISION_DOCUMENT)
            const argv = readJson<string[]>(capture)
            assert.ok(argv.includes("bypassPermissions"))
            assert.equal(argv.includes("--json-schema"), false)
            assert.doesNotMatch(valueAfter(argv, "--system-prompt"), /PRE-ACCEPTANCE VALIDATION/)
        })
    })
})

async function runArchitect(
    dir: string,
    backend: "claude" | "codex" | "opencode" | "pi",
    backendArgs: string[],
): Promise<ScriptResult> {
    return runScript([
        "--goal", "Validate the candidate goal against the repository",
        "--cwd", dir,
        "--llm", backend,
        ...backendArgs,
        "--outcome-file", join(dir, "outcome.json"),
        "--conversation-session-id", "session-trusted",
        "--goal-request-id", "goal-request-trusted",
        "--architect-request-id", "architect-request-trusted",
    ])
}

function assertTransport(dir: string): void {
    const transport = readJson<{
        schemaVersion: number
        sessionId: string
        goalRequestId: string
        architectRequestId: string
        outcome: unknown
    }>(join(dir, "outcome.json"))
    assert.equal(transport.schemaVersion, 1)
    assert.equal(transport.sessionId, "session-trusted")
    assert.equal(transport.goalRequestId, "goal-request-trusted")
    assert.equal(transport.architectRequestId, "architect-request-trusted")
    assert.deepEqual(transport.outcome, NEEDS_INPUT)
}

function writeFakeClaude(dir: string, payload: unknown, capture: string): string {
    return executable(dir, "fake-claude.mjs", `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
const payload = ${JSON.stringify(payload)};
console.log(JSON.stringify({ result: JSON.stringify(payload), structured_output: payload }));
`)
}

function writeFakeClaudeRaw(dir: string, raw: string, capture: string): string {
    return executable(dir, "fake-legacy-claude.mjs", `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ result: ${JSON.stringify(raw)} }));
`)
}

function writeFakeCodex(dir: string, payload: unknown, capture: string): string {
    return executable(dir, "fake-codex.mjs", `
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const schemaIndex = argv.indexOf("--output-schema");
const schema = schemaIndex >= 0 ? JSON.parse(readFileSync(argv[schemaIndex + 1], "utf8")) : null;
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv, schema }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Repository inspection is complete; preparing the terminal outcome." } }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(${JSON.stringify(payload)}) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
`)
}

function writeFakeOpenCode(dir: string, payload: unknown, capture: string): string {
    return executable(dir, "fake-opencode.mjs", `
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  argv,
  cwd: process.cwd(),
  input,
  configContent: process.env.OPENCODE_CONFIG_CONTENT,
}));
console.log(JSON.stringify({ type: "text", part: { text: JSON.stringify(${JSON.stringify(payload)}) } }));
`)
}

function writeFakePi(dir: string, payload: unknown, capture: string): string {
    return executable(dir, "fake-pi.mjs", `
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  argv,
  cwd: process.cwd(),
  input,
}));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(${JSON.stringify(payload)}) }] } }));
`)
}

function executable(dir: string, name: string, body: string): string {
    const path = join(dir, name)
    writeFileSync(path, `#!/usr/bin/env node\n${body}`)
    chmodSync(path, 0o755)
    return path
}

function runScript(args: string[]): Promise<ScriptResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(TSX, [RUN_ARCHITECT, ...args], {
            cwd: REPO_ROOT,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk
        })
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk
        })
        child.on("error", reject)
        child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }))
    })
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T
}

function valueAfter(argv: readonly string[], flag: string): string {
    const index = argv.indexOf(flag)
    assert.ok(index >= 0, `missing ${flag}: ${JSON.stringify(argv)}`)
    return argv[index + 1] ?? ""
}
