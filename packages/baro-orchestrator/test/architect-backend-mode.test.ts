import assert from "node:assert/strict"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { runArchitectClaude } from "../src/planning/architect-claude.js"
import { runArchitectCodex } from "../src/planning/architect-codex.js"
import type {
    ArchitectInvocationMetadata,
    ArchitectInvocationObserver,
} from "../src/planning/architect-invocation.js"
import { runArchitectOpenCode } from "../src/planning/architect-opencode.js"
import { runArchitectPi } from "../src/planning/architect-pi.js"
import type { RunnerInvocationObservation } from "../src/runner-invocation.js"
import { withTempDir } from "./participants/helpers.js"

const DECISION_DOCUMENT = `## Existing context
The fixture repository has one provider-neutral contract.

## ADR-001: Keep the fixture stable
**Status:** Accepted
**Context:** The test requires a valid decision document.
**Decision:** Preserve the strict outcome boundary.
**Consequences:** Provider prose cannot cross the boundary.`

const DECISION_OUTCOME = {
    schemaVersion: 1,
    kind: "ready",
    message: "Repository validation passed; planning may proceed.",
    questions: [],
    evidence: [],
    decisionDocument: DECISION_DOCUMENT,
} as const

describe("Architect CLI backend outcome contract modes", () => {
    it("selects the ADR-only prompt and schema for Claude without changing the default", async () => {
        await withTempDir("baro-architect-claude-mode-", async (dir) => {
            const decisionCapture = join(dir, "decision.json")
            const completeCapture = join(dir, "complete.json")
            const decisionBin = writeFakeClaude(dir, "decision-claude.mjs", decisionCapture)
            const completeBin = writeFakeClaude(dir, "complete-claude.mjs", completeCapture)

            await runArchitectClaude({
                goal: "Keep the fixture stable",
                cwd: dir,
                claudeBin: decisionBin,
                outcomeMode: true,
                outcomeContractMode: "decision",
                readOnly: true,
            })
            await runArchitectClaude({
                goal: "Keep the fixture stable",
                cwd: dir,
                claudeBin: completeBin,
                outcomeMode: true,
                readOnly: true,
            })

            const decisionArgv = readJson<string[]>(decisionCapture)
            const completeArgv = readJson<string[]>(completeCapture)
            assertDecisionPrompt(valueAfter(decisionArgv, "--system-prompt"))
            assertCompletePrompt(valueAfter(completeArgv, "--system-prompt"))
            assertDecisionSchema(JSON.parse(valueAfter(decisionArgv, "--json-schema")))
            assertCompleteSchema(JSON.parse(valueAfter(completeArgv, "--json-schema")))
        })
    })

    it("selects the ADR-only prompt and schema for Codex without changing the default", async () => {
        await withTempDir("baro-architect-codex-mode-", async (dir) => {
            const decisionCapture = join(dir, "decision.json")
            const completeCapture = join(dir, "complete.json")
            const decisionBin = writeFakeCodex(dir, "decision-codex.mjs", decisionCapture)
            const completeBin = writeFakeCodex(dir, "complete-codex.mjs", completeCapture)

            await runArchitectCodex({
                goal: "Keep the fixture stable",
                cwd: dir,
                codexBin: decisionBin,
                outcomeMode: true,
                outcomeContractMode: "decision",
                readOnly: true,
            })
            await runArchitectCodex({
                goal: "Keep the fixture stable",
                cwd: dir,
                codexBin: completeBin,
                outcomeMode: true,
                readOnly: true,
            })

            const decision = readJson<{ argv: string[]; schema: unknown }>(decisionCapture)
            const complete = readJson<{ argv: string[]; schema: unknown }>(completeCapture)
            assertDecisionPrompt(decision.argv.at(-1) ?? "")
            assertCompletePrompt(complete.argv.at(-1) ?? "")
            assertDecisionSchema(decision.schema)
            assertCompleteSchema(complete.schema)
        })
    })

    it("selects phase-specific safe evaluator prompts for OpenCode and Pi", async () => {
        for (const backend of ["opencode", "pi"] as const) {
            await withTempDir(`baro-architect-${backend}-mode-`, async (dir) => {
                const decisionCapture = join(dir, "decision.json")
                const completeCapture = join(dir, "complete.json")
                const decisionBin = backend === "opencode"
                    ? writeFakeOpenCode(dir, "decision-opencode.mjs", decisionCapture)
                    : writeFakePi(dir, "decision-pi.mjs", decisionCapture)
                const completeBin = backend === "opencode"
                    ? writeFakeOpenCode(dir, "complete-opencode.mjs", completeCapture)
                    : writeFakePi(dir, "complete-pi.mjs", completeCapture)

                if (backend === "opencode") {
                    await runArchitectOpenCode({
                        goal: "Keep the fixture stable",
                        cwd: dir,
                        opencodeBin: decisionBin,
                        outcomeMode: true,
                        outcomeContractMode: "decision",
                    })
                    await runArchitectOpenCode({
                        goal: "Keep the fixture stable",
                        cwd: dir,
                        opencodeBin: completeBin,
                        outcomeMode: true,
                    })
                } else {
                    await runArchitectPi({
                        goal: "Keep the fixture stable",
                        cwd: dir,
                        piBin: decisionBin,
                        outcomeMode: true,
                        outcomeContractMode: "decision",
                    })
                    await runArchitectPi({
                        goal: "Keep the fixture stable",
                        cwd: dir,
                        piBin: completeBin,
                        outcomeMode: true,
                    })
                }

                const decision = readJson<Capture>(decisionCapture)
                const complete = readJson<Capture>(completeCapture)
                assertDecisionPrompt(evaluatorPrompt(backend, decision))
                assertCompletePrompt(evaluatorPrompt(backend, complete))
            })
        }
    })
})

describe("Architect CLI backend invocation telemetry", () => {
    it("forwards normalized observations without letting observers alter success", async () => {
        await withTempDir("baro-architect-invocation-", async (dir) => {
            const observations: Array<{
                backend: string
                observation: RunnerInvocationObservation
                metadata: ArchitectInvocationMetadata
            }> = []
            const observer = (backend: string): ArchitectInvocationObserver =>
                (observation, metadata) => {
                    observations.push({ backend, observation, metadata })
                    throw new Error("observer failure must stay observational")
                }

            const claudeBin = executable(dir, "telemetry-claude.mjs", `
console.log(JSON.stringify({
  result: ${JSON.stringify(DECISION_DOCUMENT)},
  duration_ms: 123,
  total_cost_usd: 0.004,
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 2,
    output_tokens: 3,
  },
}));
`)
            const codexBin = executable(dir, "telemetry-codex.mjs", `
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(DECISION_DOCUMENT)} } }));
console.log(JSON.stringify({
  type: "turn.completed",
  model: "gpt-5.5-codex-live",
  usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 5 },
}));
`)
            const openCodeBin = executable(dir, "telemetry-opencode.mjs", `
console.log(JSON.stringify({ type: "text", part: { text: ${JSON.stringify(DECISION_DOCUMENT)} } }));
console.log(JSON.stringify({
  type: "step_finish",
  part: {
    providerID: "zhipu",
    modelID: "glm-5-live",
    tokens: { total: 100, input: 70, output: 7, reasoning: 3, cache: { read: 20, write: 0 } },
    cost: 0.001,
  },
}));
`)
            const piBin = executable(dir, "telemetry-pi.mjs", `
console.log(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-live",
    responseId: "provider-response-1",
    usage: { input: 10, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 20, cost: { total: 0.002 } },
    content: [{ type: "text", text: ${JSON.stringify(DECISION_DOCUMENT)} }],
  },
}));
`)

            assert.equal(await runArchitectClaude({
                goal: "Observe Claude",
                cwd: dir,
                claudeBin,
                onInvocation: observer("claude"),
            }), DECISION_DOCUMENT)
            assert.equal(await runArchitectCodex({
                goal: "Observe Codex",
                cwd: dir,
                codexBin,
                onInvocation: observer("codex"),
            }), DECISION_DOCUMENT)
            assert.equal(await runArchitectOpenCode({
                goal: "Observe OpenCode",
                cwd: dir,
                opencodeBin: openCodeBin,
                onInvocation: observer("opencode"),
            }), DECISION_DOCUMENT)
            assert.equal(await runArchitectPi({
                goal: "Observe Pi",
                cwd: dir,
                piBin,
                onInvocation: observer("pi"),
            }), DECISION_DOCUMENT)

            assert.deepEqual(
                observations.map(({ backend, observation, metadata }) => ({
                    backend,
                    sequence: observation.sequence,
                    granularity: observation.granularity,
                    status: observation.status,
                    resolvedModel: observation.resolvedModel,
                    measurementPublished: metadata.measurementPublished,
                })),
                [
                    { backend: "claude", sequence: 1, granularity: "process", status: "succeeded", resolvedModel: "opus", measurementPublished: false },
                    { backend: "codex", sequence: 1, granularity: "turn", status: "succeeded", resolvedModel: "gpt-5.5-codex-live", measurementPublished: false },
                    { backend: "opencode", sequence: 1, granularity: "round", status: "succeeded", resolvedModel: "glm-5-live", measurementPublished: false },
                    { backend: "pi", sequence: 1, granularity: "turn", status: "succeeded", resolvedModel: "deepseek-v4-live", measurementPublished: false },
                ],
            )
        })
    })

    it("reports Claude parse and process failures without replacing them", async () => {
        await withTempDir("baro-architect-claude-failure-", async (dir) => {
            const malformedBin = executable(
                dir,
                "malformed-claude.mjs",
                'process.stdout.write("not-json");',
            )
            const failedBin = executable(
                dir,
                "failed-claude.mjs",
                "process.exitCode = 7;",
            )
            const observations: RunnerInvocationObservation[] = []
            const throwingObserver: ArchitectInvocationObserver =
                (observation) => {
                    observations.push(observation)
                    throw new Error("observer failure must stay observational")
                }

            await assert.rejects(
                runArchitectClaude({
                    goal: "Malformed wrapper",
                    cwd: dir,
                    claudeBin: malformedBin,
                    onInvocation: throwingObserver,
                }),
                (error: unknown) => {
                    assert.notEqual(
                        (error as Error).message,
                        "observer failure must stay observational",
                    )
                    return true
                },
            )
            await assert.rejects(
                runArchitectClaude({
                    goal: "Failed process",
                    cwd: dir,
                    claudeBin: failedBin,
                    onInvocation: throwingObserver,
                }),
                (error: unknown) => {
                    assert.notEqual(
                        (error as Error).message,
                        "observer failure must stay observational",
                    )
                    return true
                },
            )

            assert.deepEqual(
                observations.map((observation) => ({
                    status: observation.status,
                    total: observation.tokens.total,
                })),
                [
                    {
                        status: "succeeded",
                        total: { state: "unknown", reason: "parse_error" },
                    },
                    {
                        status: "failed",
                        total: { state: "unknown", reason: "not_reported" },
                    },
                ],
            )
        })
    })

    it("does not report a model invocation when a CLI executable never dispatches", async () => {
        await withTempDir("baro-architect-no-dispatch-", async (dir) => {
            const missing = join(dir, "definitely-missing-harness")
            const observations: RunnerInvocationObservation[] = []
            const onInvocation: ArchitectInvocationObserver = (observation) => {
                observations.push(observation)
            }
            const calls: Array<() => Promise<string>> = [
                () => runArchitectClaude({
                    goal: "No dispatch",
                    cwd: dir,
                    claudeBin: missing,
                    onInvocation,
                }),
                () => runArchitectCodex({
                    goal: "No dispatch",
                    cwd: dir,
                    codexBin: missing,
                    onInvocation,
                }),
                () => runArchitectOpenCode({
                    goal: "No dispatch",
                    cwd: dir,
                    opencodeBin: missing,
                    onInvocation,
                }),
                () => runArchitectPi({
                    goal: "No dispatch",
                    cwd: dir,
                    piBin: missing,
                    onInvocation,
                }),
            ]

            for (const call of calls) {
                await assert.rejects(call(), (error: unknown) =>
                    (error as { code?: unknown }).code === "ENOENT"
                )
            }
            assert.deepEqual(observations, [])
        })
    })
})

interface Capture {
    argv: string[]
    configContent?: string
}

function evaluatorPrompt(backend: "opencode" | "pi", capture: Capture): string {
    if (backend === "pi") return valueAfter(capture.argv, "--system-prompt")
    const config = JSON.parse(capture.configContent ?? "{}") as {
        agent?: Record<string, { prompt?: string }>
    }
    return config.agent?.["baro-critic"]?.prompt ?? ""
}

function assertDecisionPrompt(prompt: string): void {
    assert.match(prompt, /DECISION PHASE — ADRs ONLY/u)
    assert.doesNotMatch(prompt, /SEMANTIC OBLIGATION APPENDIX — REQUIRED/u)
}

function assertCompletePrompt(prompt: string): void {
    assert.match(prompt, /SEMANTIC OBLIGATION APPENDIX — REQUIRED/u)
    assert.doesNotMatch(prompt, /DECISION PHASE — ADRs ONLY/u)
}

function assertDecisionSchema(value: unknown): void {
    const document = decisionDocumentSchema(value)
    assert.equal("pattern" in document, false)
    assert.equal(document.maxLength, 48 * 1024)
}

function assertCompleteSchema(value: unknown): void {
    const document = decisionDocumentSchema(value)
    assert.match(String(document.pattern ?? ""), /baro-obligations-v1/u)
}

function decisionDocumentSchema(value: unknown): Record<string, unknown> {
    const schema = value as {
        properties?: { decisionDocument?: { anyOf?: unknown[] } }
    }
    const document = schema.properties?.decisionDocument?.anyOf?.[0]
    assert.ok(document && typeof document === "object")
    return document as Record<string, unknown>
}

function writeFakeClaude(dir: string, name: string, capture: string): string {
    return executable(dir, name, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
const payload = ${JSON.stringify(DECISION_OUTCOME)};
console.log(JSON.stringify({ result: JSON.stringify(payload), structured_output: payload }));
`)
}

function writeFakeCodex(dir: string, name: string, capture: string): string {
    return executable(dir, name, `
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const schemaIndex = argv.indexOf("--output-schema");
const schema = JSON.parse(readFileSync(argv[schemaIndex + 1], "utf8"));
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv, schema }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(${JSON.stringify(DECISION_OUTCOME)}) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
`)
}

function writeFakeOpenCode(dir: string, name: string, capture: string): string {
    return executable(dir, name, `
import { writeFileSync } from "node:fs";
for await (const _chunk of process.stdin) {}
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  argv: process.argv.slice(2),
  configContent: process.env.OPENCODE_CONFIG_CONTENT,
}));
console.log(JSON.stringify({ type: "text", part: { text: JSON.stringify(${JSON.stringify(DECISION_OUTCOME)}) } }));
`)
}

function writeFakePi(dir: string, name: string, capture: string): string {
    return executable(dir, name, `
import { writeFileSync } from "node:fs";
for await (const _chunk of process.stdin) {}
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2) }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(${JSON.stringify(DECISION_OUTCOME)}) }] } }));
`)
}

function executable(dir: string, name: string, body: string): string {
    const path = join(dir, name)
    writeFileSync(path, `#!/usr/bin/env node\n${body}`)
    chmodSync(path, 0o755)
    return path
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T
}

function valueAfter(argv: readonly string[], flag: string): string {
    const index = argv.indexOf(flag)
    assert.ok(index >= 0, `missing ${flag}: ${JSON.stringify(argv)}`)
    return argv[index + 1] ?? ""
}
