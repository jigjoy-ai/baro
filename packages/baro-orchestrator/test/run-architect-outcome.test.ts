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

interface ModelUsageEvent {
    type: "model_usage"
    measurement: {
        backend: string
        requestedModel: string | null
        status: string
        invocationId: string
    }
}

function modelUsageEvents(stdout: string): ModelUsageEvent[] {
    return stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as {
            type?: unknown
            measurement?: unknown
        })
        .filter((event): event is ModelUsageEvent =>
            event.type === "model_usage" &&
            typeof event.measurement === "object" &&
            event.measurement !== null
        )
}

describe("run-architect ArchitectOutcomeV1 mode", () => {
    it("wraps fake Claude output with trusted correlation and read-only flags", async () => {
        await withTempDir("baro-architect-outcome-claude-", async (dir) => {
            const capture = join(dir, "claude-capture.json")
            const binary = writeFakeClaude(dir, NEEDS_INPUT, capture)
            const run = await runArchitect(dir, "claude", ["--claude-bin", binary])

            assert.equal(run.code, 0, run.stderr)
            const [usage] = modelUsageEvents(run.stdout)
            assert.ok(usage)
            assert.equal(usage.measurement.backend, "claude")
            assert.equal(usage.measurement.requestedModel, "opus")
            assert.equal(usage.measurement.status, "succeeded")
            assert.match(
                usage.measurement.invocationId,
                /architect-decision:1:provider:1$/u,
            )
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

    it("assembles a ready Codex decision from a separate bounded obligation call", async () => {
        await withTempDir("baro-architect-outcome-codex-ready-", async (dir) => {
            const capture = join(dir, "codex-phases.jsonl")
            const binary = writePhasedFakeCodex(dir, capture)
            const run = await runArchitect(dir, "codex", [
                "--codex-bin", binary,
                "--effort", "high",
            ])

            assert.equal(run.code, 0, run.stderr)
            const transport = readJson<{
                outcome: {
                    kind: string
                    decisionDocument: string
                }
            }>(join(dir, "outcome.json"))
            assert.equal(transport.outcome.kind, "ready")
            assert.match(
                transport.outcome.decisionDocument,
                /```baro-obligations-v1\n/u,
            )
            assert.match(transport.outcome.decisionDocument, /"id":"O-001"/u)
            assert.match(
                transport.outcome.decisionDocument,
                /"invariantIds":\["G-A1"\]/u,
            )

            const invocations = readFileSync(capture, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as {
                    argv: string[]
                    input: string
                })
            assert.equal(invocations.length, 2)
            assert.ok(invocations[0]!.argv.includes("--output-schema"))
            assert.equal(invocations[1]!.argv.includes("--output-schema"), false)
            for (const invocation of invocations) {
                assert.ok(
                    invocation.argv.includes('model_reasoning_effort="high"'),
                )
            }
            assert.match(invocations[1]!.input, /G-A1/u)
            assert.match(invocations[1]!.input, /ADR-001/u)

            const usages = modelUsageEvents(run.stdout)
            assert.equal(usages.length, 2)
            assert.deepEqual(
                usages.map((event) => event.measurement.requestedModel),
                ["codex-default", "codex-default"],
            )
            assert.match(
                usages[0]!.measurement.invocationId,
                /architect-decision:1:provider:1$/u,
            )
            assert.match(
                usages[1]!.measurement.invocationId,
                /architect-obligations:1:provider:1$/u,
            )
        })
    })

    it("assembles a ready Claude decision with the same model and effort in both phases", async () => {
        await withTempDir("baro-architect-outcome-claude-ready-", async (dir) => {
            const capture = join(dir, "claude-phases.jsonl")
            const binary = writePhasedFakeClaude(dir, capture)
            const run = await runArchitect(dir, "claude", [
                "--claude-bin", binary,
                "--effort", "max",
            ])

            assert.equal(run.code, 0, run.stderr)
            const transport = readJson<{
                outcome: { kind: string; decisionDocument: string }
            }>(join(dir, "outcome.json"))
            assert.equal(transport.outcome.kind, "ready")
            assert.match(transport.outcome.decisionDocument, /"id":"O-001"/u)

            const invocations = readFileSync(capture, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as string[])
            assert.equal(invocations.length, 2)
            assert.ok(invocations[0]!.includes("--json-schema"))
            assert.equal(invocations[1]!.includes("--json-schema"), false)
            assert.equal(valueAfter(invocations[0]!, "--tools"), "Read,Glob,Grep")
            assert.equal(valueAfter(invocations[1]!, "--tools"), "")
            assert.ok(invocations[1]!.includes("--safe-mode"))
            assert.ok(invocations[1]!.includes("--disable-slash-commands"))
            assert.ok(invocations[1]!.includes("--strict-mcp-config"))
            assert.ok(invocations[1]!.includes("--no-session-persistence"))
            assert.equal(
                valueAfter(invocations[1]!, "--mcp-config"),
                '{"mcpServers":{}}',
            )
            assert.equal(valueAfter(invocations[1]!, "--permission-mode"), "dontAsk")
            for (const argv of invocations) {
                assert.equal(valueAfter(argv, "--model"), "opus")
                assert.equal(valueAfter(argv, "--effort"), "max")
            }
            assert.deepEqual(
                modelUsageEvents(run.stdout).map((event) =>
                    event.measurement.requestedModel
                ),
                ["opus", "opus"],
            )
        })
    })

    it("shares one wall-clock budget across Codex decision and obligation phases", async () => {
        await withTempDir("baro-architect-outcome-codex-budget-", async (dir) => {
            const capture = join(dir, "codex-phases.jsonl")
            const binary = writePhasedFakeCodex(dir, capture, {
                decision: 100,
                obligation: 800,
            })
            const run = await runArchitect(dir, "codex", [
                "--codex-bin", binary,
                "--timeout-ms", "1200",
            ])

            assert.notEqual(run.code, 0, run.stderr)
            assert.match(run.stderr, /shared 1200ms phase budget/u)
            assert.equal(existsSync(join(dir, "outcome.json")), false)
            assert.ok(
                modelUsageEvents(run.stdout).some((event) =>
                    event.measurement.status === "timed_out" &&
                    /architect-obligations/u.test(event.measurement.invocationId)
                ),
                run.stdout,
            )
        })
    })

    it("uses the host-owned timeout across every CLI harness adapter", async () => {
        for (const backend of ["claude", "codex", "opencode", "pi"] as const) {
            await withTempDir(
                `baro-architect-outcome-${backend}-timeout-`,
                async (dir) => {
                    const binary = writeSlowFakeHarness(
                        dir,
                        backend,
                        NEEDS_INPUT,
                        500,
                    )
                    const binaryFlag = {
                        claude: "--claude-bin",
                        codex: "--codex-bin",
                        opencode: "--opencode-bin",
                        pi: "--pi-bin",
                    }[backend]
                    const run = await runArchitect(dir, backend, [
                        binaryFlag, binary,
                        "--timeout-ms", "50",
                    ])

                    assert.notEqual(run.code, 0, `${backend}: ${run.stderr}`)
                    assert.match(run.stderr, /timeoutMs=50/)
                    assert.match(
                        run.stderr,
                        backend === "claude"
                            ? /timed out after 50ms/
                            : /timedOut=true \(cap=50ms\)/,
                    )
                    assert.equal(existsSync(join(dir, "outcome.json")), false)
                    assert.ok(
                        modelUsageEvents(run.stdout).some((event) =>
                            event.measurement.backend === backend &&
                            event.measurement.status === "timed_out" &&
                            /architect-decision/u.test(
                                event.measurement.invocationId,
                            )
                        ),
                        `${backend}: ${run.stdout}`,
                    )
                },
            )
        }
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

    it("assembles ready OpenCode and Pi decisions through their isolated obligation phase", async () => {
        for (const backend of ["opencode", "pi"] as const) {
            await withTempDir(`baro-architect-${backend}-ready-`, async (dir) => {
                const capture = join(dir, `${backend}-phases.jsonl`)
                const binary = writePhasedFakeLocalHarness(
                    dir,
                    backend,
                    capture,
                )
                const run = await runArchitect(dir, backend, [
                    backend === "opencode" ? "--opencode-bin" : "--pi-bin",
                    binary,
                ])

                assert.equal(run.code, 0, `${backend}: ${run.stderr}`)
                const transport = readJson<{
                    outcome: { kind: string; decisionDocument: string }
                }>(join(dir, "outcome.json"))
                assert.equal(transport.outcome.kind, "ready")
                assert.match(transport.outcome.decisionDocument, /"id":"O-001"/u)

                const invocations = readFileSync(capture, "utf8")
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line) as {
                        cwd: string
                        input: string
                    })
                assert.equal(invocations.length, 2)
                assert.doesNotMatch(invocations[0]!.input, /targetInvariantIds/u)
                assert.match(invocations[1]!.input, /targetInvariantIds/u)
                assert.notEqual(invocations[0]!.cwd, dir)
                assert.notEqual(invocations[1]!.cwd, dir)
                assert.deepEqual(
                    modelUsageEvents(run.stdout).map((event) =>
                        event.measurement.requestedModel
                    ),
                    [`${backend}-default`, `${backend}-default`],
                )
            })
        }
    })

    it("fails closed before writing transport when a provider forges authority", async () => {
        await withTempDir("baro-architect-outcome-forged-", async (dir) => {
            const forged = { ...NEEDS_INPUT, sessionId: "model-session" }
            const binary = writeFakeClaude(dir, forged, join(dir, "capture.json"))
            const outcomePath = join(dir, "outcome.json")
            writeFileSync(outcomePath, "pre-existing-sentinel")
            const run = await runArchitect(dir, "claude", ["--claude-bin", binary])

            assert.notEqual(run.code, 0)
            assert.match(run.stderr, /exact v1 schema/)
            assert.equal(readFileSync(outcomePath, "utf8"), "pre-existing-sentinel")
        })
    })

    it("contains Gateway billing configuration errors in the normal failure path", async () => {
        await withTempDir("baro-architect-outcome-billing-config-", async (dir) => {
            const run = await runArchitect(dir, "openai", [], {
                ...process.env,
                BARO_GATEWAY_BILLING_URL: "http://127.0.0.1:8787",
                BARO_GATEWAY_BILLING_API_KEY: "",
                JIGJOY_API_KEY: "",
                OPENAI_API_KEY: "",
            })

            assert.equal(run.code, 1, run.stderr)
            assert.match(run.stderr, /\[run-architect\] FAILED after/u)
            assert.doesNotMatch(run.stderr, /\[run-architect\] crashed:/u)
            assert.equal(existsSync(join(dir, "outcome.json")), false)
        })
    })

    it("contains hostile Codex type metadata on the full failure path", async () => {
        await withTempDir("baro-architect-outcome-hostile-type-", async (dir) => {
            const name = "BARO_TEST_TOKEN"
            const secret = "hostile-type-secret-value"
            const previous = process.env[name]
            process.env[name] = secret
            let run: ScriptResult
            try {
                const binary = writeHostileFakeCodex(dir, secret)
                run = await runArchitect(dir, "codex", [
                    "--codex-bin",
                    binary,
                ])
            } finally {
                if (previous === undefined) delete process.env[name]
                else process.env[name] = previous
            }

            assert.notEqual(run!.code, 0)
            assert.doesNotMatch(run!.stderr, /hostile-type-secret-value/u)
            assert.doesNotMatch(
                run!.stderr,
                /^\[codex-architect\] diagnostic FORGED_/mu,
            )
            assert.match(
                run!.stderr,
                /event_types=\[\(invalid\),item\.completed\]/u,
            )
            assert.match(run!.stderr, /item_types=\[\(invalid\)\]/u)
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
    backend: "claude" | "openai" | "codex" | "opencode" | "pi",
    backendArgs: string[],
    environment: NodeJS.ProcessEnv = process.env,
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
        "--goal", "Validate the candidate goal against the repository",
        "--cwd", dir,
        "--llm", backend,
        ...backendArgs,
        "--outcome-file", join(dir, "outcome.json"),
        "--goal-envelope-file", goalEnvelopeFile,
        "--conversation-session-id", "session-trusted",
        "--goal-request-id", "goal-request-trusted",
        "--architect-request-id", "architect-request-trusted",
    ], environment)
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

function writePhasedFakeClaude(dir: string, capture: string): string {
    const ready = {
        schemaVersion: 1,
        kind: "ready",
        message: "Repository validation is complete.",
        questions: [],
        evidence: [],
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
    return executable(dir, "fake-phased-claude.mjs", `
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(capture)}, JSON.stringify(argv) + "\\n");
const decisionPhase = argv.includes("--json-schema");
const payload = decisionPhase
  ? ${JSON.stringify(ready)}
  : ${JSON.stringify(segment)};
console.log(JSON.stringify({
  result: JSON.stringify(payload),
  ...(decisionPhase ? { structured_output: payload } : {}),
  usage: { input_tokens: 10, output_tokens: 5 },
}));
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

function writePhasedFakeCodex(
    dir: string,
    capture: string,
    delay: number | { decision: number; obligation: number } = 0,
): string {
    const decisionDelay = typeof delay === "number" ? delay : delay.decision
    const obligationDelay = typeof delay === "number" ? delay : delay.obligation
    const ready = {
        schemaVersion: 1,
        kind: "ready",
        message: "Repository validation is complete.",
        questions: [],
        evidence: [],
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
    return executable(dir, "fake-phased-codex.mjs", `
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
let input = "";
if (argv.includes("-")) {
  for await (const chunk of process.stdin) input += chunk;
} else {
  input = argv.at(-1) ?? "";
}
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv, input }) + "\\n");
const payload = argv.includes("--output-schema")
  ? ${JSON.stringify(ready)}
  : ${JSON.stringify(segment)};
const delayMs = argv.includes("--output-schema")
  ? ${decisionDelay}
  : ${obligationDelay};
setTimeout(() => {
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
}, delayMs);
`)
}

function writePhasedFakeLocalHarness(
    dir: string,
    backend: "opencode" | "pi",
    capture: string,
): string {
    const ready = {
        schemaVersion: 1,
        kind: "ready",
        message: "Repository validation is complete.",
        questions: [],
        evidence: [],
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
    const output = backend === "opencode"
        ? `console.log(JSON.stringify({ type: "text", part: { text: JSON.stringify(payload) } }));`
        : `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(payload) }] } }));`
    return executable(dir, `fake-phased-${backend}.mjs`, `
import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
  cwd: process.cwd(),
  input,
}) + "\\n");
const payload = input.includes("targetInvariantIds")
  ? ${JSON.stringify(segment)}
  : ${JSON.stringify(ready)};
${output}
`)
}

function writeHostileFakeCodex(dir: string, secret: string): string {
    return executable(dir, "fake-hostile-codex.mjs", `
console.log(JSON.stringify({ type: ${JSON.stringify(`unexpected\n[codex-architect] diagnostic FORGED_EVENT ${secret}`)} }));
console.log(JSON.stringify({
  type: "item.completed",
  item: { type: ${JSON.stringify(`unexpected\n[codex-architect] diagnostic FORGED_ITEM ${secret}`)} },
}));
process.exit(1);
`)
}

function writeSlowFakeHarness(
    dir: string,
    backend: "claude" | "codex" | "opencode" | "pi",
    payload: unknown,
    delayMs: number,
): string {
    const output = backend === "claude"
        ? `console.log(JSON.stringify({ result: JSON.stringify(payload), structured_output: payload }));`
        : backend === "codex"
          ? `console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));`
          : backend === "opencode"
            ? `console.log(JSON.stringify({ type: "text", part: { text: JSON.stringify(payload) } }));`
            : `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(payload) }] } }));`
    const readInput = backend === "opencode" || backend === "pi"
        ? `for await (const _chunk of process.stdin) {}`
        : ""
    return executable(dir, `fake-slow-${backend}.mjs`, `
const payload = ${JSON.stringify(payload)};
${readInput}
setTimeout(() => {
  ${output}
}, ${delayMs});
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

function runScript(
    args: string[],
    environment: NodeJS.ProcessEnv = process.env,
): Promise<ScriptResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(TSX, [RUN_ARCHITECT, ...args], {
            cwd: REPO_ROOT,
            env: environment,
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
