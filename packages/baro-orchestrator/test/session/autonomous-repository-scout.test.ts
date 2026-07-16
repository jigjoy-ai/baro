import assert from "node:assert/strict"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import type { Tool } from "@mozaik-ai/core"

import {
    AutonomousRepositoryScanner,
    type RepositoryScoutResponder,
    type RepositoryScoutResponderInput,
} from "../../src/session/autonomous-repository-scout.js"
import { createReadOnlyRepositoryScoutTools } from "../../src/session/repository-research-tools.js"
import { DeterministicRepositoryScanner } from "../../src/session/repository-scanner.js"

const CORRELATION = Object.freeze({
    sessionId: "session-autonomous-scout",
    requestId: "request-autonomous-scout",
    contextRequestId: "repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
})

describe("AutonomousRepositoryScanner", () => {
    it("runs a correlated multi-step read/search/glob loop and grounds the final brief", async () => {
        await withRepository(async (root) => {
            mkdirSync(join(root, "src"))
            writeFileSync(
                join(root, "src", "auth.ts"),
                "export function authenticate(token: string) { return token.length > 0 }\n",
            )
            writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n')

            const calls: RepositoryScoutResponderInput[] = []
            const responder = scriptedResponder(calls, [
                (input) => decision(input, {
                    action: "glob",
                    pattern: "src/**/*.ts",
                }),
                (input) => decision(input, {
                    action: "search",
                    pattern: "authenticate",
                    path: "src",
                    filePattern: "*.ts",
                }),
                (input) => decision(input, {
                    action: "read",
                    path: "src/auth.ts",
                }),
                (input) => decision(input, {
                    action: "finish",
                    summary: "Authentication is implemented in the selected source file.",
                    facts: [{
                        statement: "The source exports an authenticate function.",
                        evidencePath: "src/auth.ts",
                        line: 1,
                        confidence: "high",
                    }],
                    relevantPaths: ["src/auth.ts"],
                    unknowns: ["Call-site compatibility was not inspected."],
                    truncated: false,
                }),
            ])
            const scanner = new AutonomousRepositoryScanner(root, { responder })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.equal(calls.length, 4)
            assert.deepEqual(
                calls.map((call) => [
                    call.sessionId,
                    call.requestId,
                    call.contextRequestId,
                    call.step,
                ]),
                [1, 2, 3, 4].map((step) => [
                    CORRELATION.sessionId,
                    CORRELATION.requestId,
                    CORRELATION.contextRequestId,
                    step,
                ]),
            )
            assert.match(calls[1]!.userPrompt, /src\/auth\.ts/)
            assert.match(calls[2]!.userPrompt, /authenticate/)
            assert.equal(brief.summary, "Authentication is implemented in the selected source file.")
            assert.equal(brief.facts[0]?.evidencePath, "src/auth.ts")
            assert.ok(brief.unknowns.includes(
                "Repository behavior and build/test results were not executed or verified.",
            ))
            assert.equal(brief.truncated, false)
            assert.match(brief.snapshotId, /^sha256:[a-f0-9]{64}$/u)
        })
    })

    it("repairs a shallow truncated-bootstrap finish before handing context to Conversation", async () => {
        await withRepository(async (root) => {
            const shallowPaths = [
                "package.json",
                "README.md",
                "Cargo.toml",
                "Cargo.lock",
                "AGENTS.md",
                "CLAUDE.md",
                "yarn.lock",
                "eslint.config.js",
            ]
            const focusedPath = "src/runtime/cancellation.ts"
            const bootstrap = {
                schemaVersion: 1 as const,
                snapshotId: `sha256:${"a".repeat(64)}`,
                summary: "A ranked cancellation bootstrap whose bounded output was truncated.",
                facts: [{
                    statement: "The leading source path matched cancellation terms.",
                    evidencePath: focusedPath,
                    confidence: "high" as const,
                }],
                relevantPaths: [...shallowPaths, focusedPath, "tests/cancellation.test.ts"],
                unknowns: ["Additional ranked paths were omitted."],
                truncated: true,
            }
            const calls: RepositoryScoutResponderInput[] = []
            const scanner = new AutonomousRepositoryScanner(root, {
                bootstrapScanner: { async scan() { return bootstrap } },
                tools: fakeResearchTools({
                    read_file: "export const cooperativeCancellation = true\n",
                }),
                responder: {
                    backend: "codex",
                    async respond(input) {
                        calls.push(input)
                        if (input.step === 1) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: "package.json",
                            }))
                        }
                        if (input.step === 2 && input.attempt === 1) {
                            return JSON.stringify(decision(input, {
                                action: "finish",
                                summary: "Only package metadata was inspected.",
                                facts: [{
                                    statement: "The package manifest was read.",
                                    evidencePath: "package.json",
                                    line: 1,
                                    confidence: "high",
                                }],
                                relevantPaths: ["package.json"],
                                unknowns: ["Source details remain unknown."],
                                truncated: true,
                            }))
                        }
                        if (input.step === 2) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: focusedPath,
                            }))
                        }
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "A leading cancellation source path was inspected.",
                            facts: [{
                                statement: "The leading source exposes cancellation behavior.",
                                evidencePath: focusedPath,
                                line: 1,
                                confidence: "high",
                            }],
                            relevantPaths: [focusedPath],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })

            const brief = await scanner.scan(
                scanRequest(),
                new AbortController().signal,
            )

            assert.deepEqual(
                calls.map((call) => [call.step, call.attempt]),
                [[1, 1], [2, 1], [2, 2], [3, 1]],
            )
            assert.match(
                calls[2]!.userPrompt,
                /must ground one of the explicit FOCUSED BOOTSTRAP PATHS/u,
            )
            assert.match(
                calls[0]!.userPrompt,
                /FOCUSED BOOTSTRAP PATHS: \["src\/runtime\/cancellation\.ts","tests\/cancellation\.test\.ts"\]/u,
            )
            assert.equal(brief.facts[0]?.evidencePath, focusedPath)
            assert.ok(brief.relevantPaths.includes("package.json"))
            assert.ok(brief.relevantPaths.includes("tests/cancellation.test.ts"))
            assert.equal(
                brief.summary,
                "A leading cancellation source path was inspected.",
            )
        })
    })

    it("binds the success snapshot to ordered model-visible observations", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "stable bootstrap content\n")
            const bootstrap = await new DeterministicRepositoryScanner(root).scan(
                scanRequest(),
                new AbortController().signal,
            )
            const run = async (output: string) => {
                const scanner = new AutonomousRepositoryScanner(root, {
                    tools: fakeResearchTools({ read_file: output }),
                    responder: {
                        backend: "codex",
                        async respond(input) {
                            if (input.step === 1) {
                                return JSON.stringify(decision(input, {
                                    action: "read",
                                    path: "README.md",
                                }))
                            }
                            return JSON.stringify(decision(input, {
                                action: "finish",
                                summary: "The bounded read observation was inspected.",
                                facts: [{
                                    statement: "README produced one visible source line.",
                                    evidencePath: "README.md",
                                    line: 1,
                                    confidence: "high",
                                }],
                                relevantPaths: ["README.md"],
                                unknowns: [],
                                truncated: false,
                            }))
                        },
                    },
                })
                return await scanner.scan(scanRequest(), new AbortController().signal)
            }

            const alpha = await run("alpha observation\n")
            const beta = await run("beta observation\n")
            assert.notEqual(alpha.snapshotId, bootstrap.snapshotId)
            assert.notEqual(beta.snapshotId, bootstrap.snapshotId)
            assert.notEqual(alpha.snapshotId, beta.snapshotId)
        })
    })

    it("binds the success snapshot to the exact goal-specific bootstrap projection", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "auth.ts"), "export const authBoundary = true\n")
            writeFileSync(join(root, "billing.ts"), "export const billingBoundary = true\n")
            const scanner = new AutonomousRepositoryScanner(root, {
                responder: {
                    backend: "codex",
                    async respond(input) {
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "The bounded bootstrap was inspected.",
                            facts: [],
                            relevantPaths: [],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })

            const auth = await scanner.scan(
                { ...scanRequest(), query: "Inspect authBoundary." },
                new AbortController().signal,
            )
            const billing = await scanner.scan(
                { ...scanRequest(), query: "Inspect billingBoundary." },
                new AbortController().signal,
            )

            assert.notEqual(auth.snapshotId, billing.snapshotId)
        })
    })

    it("does not trust bootstrap paths clipped out of the provider-visible prefix", async () => {
        await withRepository(async (root) => {
            const relevantPaths = Array.from(
                { length: 8 },
                (_, index) => `src/bootstrap-tail-${index}.ts`,
            )
            const bootstrap = {
                schemaVersion: 1 as const,
                snapshotId: `sha256:${"c".repeat(64)}`,
                summary: "s".repeat(1_500),
                facts: relevantPaths.map((evidencePath, index) => ({
                    statement: `${index}:${"f".repeat(500)}`,
                    evidencePath,
                    confidence: "medium" as const,
                })),
                relevantPaths,
                unknowns: ["Synthetic bounded bootstrap."],
                truncated: false,
            }
            const calls: RepositoryScoutResponderInput[] = []
            const scanner = new AutonomousRepositoryScanner(root, {
                maxPromptBytes: 28 * 1024,
                bootstrapScanner: { async scan() { return bootstrap } },
                responder: {
                    backend: "claude",
                    async respond(input) {
                        calls.push(input)
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "A clipped tail path was treated as visible.",
                            facts: [{
                                statement: "The tail path exists.",
                                evidencePath: relevantPaths.at(-1),
                                confidence: "medium",
                            }],
                            relevantPaths: [relevantPaths.at(-1)],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })

            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.equal(calls.length, 3)
            assert.match(calls[0]!.userPrompt, /bootstrap evidence clipped/u)
            assert.match(calls[1]!.userPrompt, /unobserved relevant path/u)
            assert.match(brief.summary, /^Deterministic fallback\./u)
        })
    })

    it("grounds finish only in observations retained by the finishing prompt", async () => {
        await withRepository(async (root) => {
            for (const name of ["auth-a.ts", "auth-b.ts", "auth-c.ts"]) {
                writeFileSync(join(root, name), `${name}:${"x".repeat(900)}\n`)
            }
            const calls: RepositoryScoutResponderInput[] = []
            const scanner = new AutonomousRepositoryScanner(root, {
                maxObservationBytes: 1_024,
                maxTranscriptBytes: 3_000,
                responder: {
                    backend: "claude",
                    async respond(input) {
                        calls.push(input)
                        if (input.step <= 3) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: `auth-${["a", "b", "c"][input.step - 1]}.ts`,
                            }))
                        }
                        const repaired = input.attempt > 1
                        const evidencePath = repaired ? "auth-c.ts" : "auth-a.ts"
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: repaired
                                ? "The retained final observation was used."
                                : "An omitted observation was used.",
                            facts: [{
                                statement: "The selected source was read.",
                                evidencePath,
                                line: 1,
                                confidence: "high",
                            }],
                            relevantPaths: [evidencePath],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })

            const brief = await scanner.scan(
                { ...scanRequest(), query: "Inspect auth sources." },
                new AbortController().signal,
            )

            assert.deepEqual(calls.slice(-2).map((call) => [call.step, call.attempt]), [
                [4, 1],
                [4, 2],
            ])
            assert.match(
                calls.at(-1)!.userPrompt,
                /fact line was not covered by a read or search observation/u,
            )
            assert.equal(brief.summary, "The retained final observation was used.")
            assert.equal(brief.truncated, true)
            assert.ok(brief.unknowns.includes(
                "Older repository observations were omitted from the finishing prompt by its byte bound.",
            ))
        })
    })

    it("allows a stateless policy to refresh an action after its old result is omitted", async () => {
        await withRepository(async (root) => {
            for (const name of ["auth-a.ts", "auth-b.ts", "auth-c.ts"]) {
                writeFileSync(join(root, name), `${name}:${"x".repeat(900)}\n`)
            }
            const calls: RepositoryScoutResponderInput[] = []
            const scanner = new AutonomousRepositoryScanner(root, {
                maxObservationBytes: 1_024,
                maxTranscriptBytes: 3_000,
                responder: {
                    backend: "claude",
                    async respond(input) {
                        calls.push(input)
                        if (input.step <= 3) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: `auth-${["a", "b", "c"][input.step - 1]}.ts`,
                            }))
                        }
                        if (input.step === 4) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: "auth-a.ts",
                            }))
                        }
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "The omitted action was refreshed and is visible again.",
                            facts: [{
                                statement: "The refreshed source was read.",
                                evidencePath: "auth-a.ts",
                                line: 1,
                                confidence: "high",
                            }],
                            relevantPaths: ["auth-a.ts"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })

            const brief = await scanner.scan(
                { ...scanRequest(), query: "Inspect auth sources." },
                new AbortController().signal,
            )

            assert.deepEqual(calls.map((call) => [call.step, call.attempt]), [
                [1, 1],
                [2, 1],
                [3, 1],
                [4, 1],
                [5, 1],
            ])
            assert.equal(
                brief.summary,
                "The omitted action was refreshed and is visible again.",
            )
        })
    })

    it("repairs an uncovered line, then accepts exact search-line provenance", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "first line\nsecond needle line\n")
            const calls: RepositoryScoutResponderInput[] = []
            const scanner = new AutonomousRepositoryScanner(root, {
                responder: {
                    backend: "openai",
                    async respond(input) {
                        calls.push(input)
                        if (input.step === 1 && input.attempt === 1) {
                            return JSON.stringify(decision(input, {
                                action: "finish",
                                summary: "Premature line claim.",
                                facts: [{
                                    statement: "README contains the needle.",
                                    evidencePath: "README.md",
                                    line: 2,
                                    confidence: "high",
                                }],
                                relevantPaths: ["README.md"],
                                unknowns: [],
                                truncated: false,
                            }))
                        }
                        if (input.step === 1) {
                            return JSON.stringify(decision(input, {
                                action: "search",
                                pattern: "needle",
                                path: "",
                                filePattern: "*.md",
                            }))
                        }
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "Search covered the exact cited line.",
                            facts: [{
                                statement: "README contains the needle.",
                                evidencePath: "README.md",
                                line: 2,
                                confidence: "high",
                            }],
                            relevantPaths: ["README.md"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.deepEqual(calls.map((call) => [call.step, call.attempt]), [
                [1, 1],
                [1, 2],
                [2, 1],
            ])
            assert.match(calls[1]!.userPrompt, /line was not covered/u)
            assert.equal(brief.facts[0]?.line, 2)
            assert.doesNotMatch(brief.summary, /^Deterministic fallback\./u)
        })
    })

    it("rejects glob-only high confidence and accepts it after a repaired read", async () => {
        await withRepository(async (root) => {
            mkdirSync(join(root, "src"))
            writeFileSync(join(root, "src", "extra.ts"), "export const neutral = true\n")
            const calls: RepositoryScoutResponderInput[] = []
            const scanner = new AutonomousRepositoryScanner(root, {
                responder: {
                    backend: "claude",
                    async respond(input) {
                        calls.push(input)
                        if (input.step === 1) {
                            return JSON.stringify(decision(input, {
                                action: "glob",
                                pattern: "src/*.ts",
                            }))
                        }
                        if (input.step === 2 && input.attempt === 1) {
                            return JSON.stringify(decision(input, {
                                action: "finish",
                                summary: "Glob alone claimed source semantics.",
                                facts: [{
                                    statement: "The source exports a neutral symbol.",
                                    evidencePath: "src/extra.ts",
                                    confidence: "high",
                                }],
                                relevantPaths: ["src/extra.ts"],
                                unknowns: [],
                                truncated: false,
                            }))
                        }
                        if (input.step === 2) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: "src/extra.ts",
                            }))
                        }
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "A read now grounds the source finding.",
                            facts: [{
                                statement: "The source exports a neutral symbol.",
                                evidencePath: "src/extra.ts",
                                line: 1,
                                confidence: "high",
                            }],
                            relevantPaths: ["src/extra.ts"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.deepEqual(calls.map((call) => [call.step, call.attempt]), [
                [1, 1],
                [2, 1],
                [2, 2],
                [3, 1],
            ])
            assert.match(calls[2]!.userPrompt, /glob-only evidence/u)
            assert.equal(brief.facts[0]?.evidencePath, "src/extra.ts")
            assert.equal(brief.facts[0]?.line, 1)
            assert.doesNotMatch(brief.summary, /^Deterministic fallback\./u)
        })
    })

    it("rejects forged model correlation and falls back to the deterministic snapshot", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "billing reconciliation\n")
            let calls = 0
            const scanner = new AutonomousRepositoryScanner(root, {
                maxDecisionRepairs: 0,
                responder: {
                    backend: "codex",
                    async respond(input) {
                        calls += 1
                        return JSON.stringify({
                            ...decision(input, {
                                action: "glob",
                                pattern: "**/*.md",
                            }),
                            contextRequestId: "repository:forged",
                        })
                    },
                },
            })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.equal(calls, 1)
            assert.match(brief.summary, /^Deterministic fallback\./u)
            assert.equal(brief.truncated, true)
            assert.ok(brief.unknowns.some((item) =>
                item.includes("Autonomous repository research did not complete"),
            ))
        })
    })

    it("uses a high configurable safety cap and reports bounded exhaustion as unknown", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "bounded research\n")
            let calls = 0
            const responder: RepositoryScoutResponder = {
                backend: "openai",
                async respond(input) {
                    calls += 1
                    return JSON.stringify(decision(input, {
                        action: "glob",
                        pattern: `**/*-${input.step}.md`,
                    }))
                },
            }
            const scanner = new AutonomousRepositoryScanner(root, {
                responder,
                maxSteps: 9,
            })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.equal(calls, 9)
            assert.equal(brief.truncated, true)
            assert.ok(brief.unknowns.some((item) =>
                item.includes("Autonomous repository research did not complete"),
            ))
            assert.ok(Buffer.byteLength(JSON.stringify(brief), "utf8") <= 64 * 1024)
        })
    })

    it("keeps the newest complete observations when the transcript is bounded", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "recent observation fixture\n")
            let finalPrompt = ""
            const scanner = new AutonomousRepositoryScanner(root, {
                maxSteps: 15,
                maxObservationBytes: 256,
                maxTranscriptBytes: 1_024,
                responder: {
                    backend: "openai",
                    async respond(input) {
                        if (input.step < 15) {
                            return JSON.stringify(decision(input, {
                                action: "glob",
                                pattern: `**/*-${input.step}.md`,
                            }))
                        }
                        finalPrompt = input.userPrompt
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "The newest bounded observations still identify README.",
                            facts: [{
                                statement: "README is an observed repository entry point.",
                                evidencePath: "README.md",
                                confidence: "medium",
                            }],
                            relevantPaths: ["README.md"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.match(finalPrompt, /older observation\(s\) omitted/u)
            assert.match(finalPrompt, /"step":14/u)
            assert.doesNotMatch(finalPrompt, /"step":1,/u)
            assert.equal(brief.relevantPaths[0], "README.md")
        })
    })

    it("caps the complete multibyte prompt while preserving the latest tool observation", async () => {
        await withRepository(async (root) => {
            writeFileSync(
                join(root, "README.md"),
                `LATEST-TOOL-OBSERVATION:${"界".repeat(2_000)}\n`,
            )
            const prompts: string[] = []
            const scanner = new AutonomousRepositoryScanner(root, {
                maxObservationBytes: 1_024,
                maxTranscriptBytes: 4 * 1024,
                maxPromptBytes: 20 * 1024,
                responder: {
                    backend: "openai",
                    async respond(input) {
                        prompts.push(input.userPrompt)
                        if (input.step === 1 && input.attempt === 1) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: "README.md",
                            }))
                        }
                        if (input.step === 1) {
                            return JSON.stringify(decision(input, {
                                action: "glob",
                                pattern: "README.md",
                            }))
                        }
                        if (input.step === 2) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: "README.md",
                            }))
                        }
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "The latest bounded observation identifies README.",
                            facts: [{
                                statement: "README contains the latest observation marker.",
                                evidencePath: "README.md",
                                confidence: "high",
                            }],
                            relevantPaths: ["README.md"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })
            const brief = await scanner.scan({
                ...scanRequest(),
                query: `MULTIBYTE-GOAL:${"界".repeat(8_000)}`,
            }, new AbortController().signal)

            const finalPrompt = prompts.at(-1)!
            const dynamicBoundary = "TRUSTED CURRENT RESEARCH CONTROL:"
            assert.equal(prompts.length, 4, prompts.at(-1))
            assert.equal(
                prompts[0]!.slice(0, prompts[0]!.indexOf(dynamicBoundary)),
                finalPrompt.slice(0, finalPrompt.indexOf(dynamicBoundary)),
            )
            assert.ok(Buffer.byteLength(finalPrompt, "utf8") <= 20 * 1024)
            assert.match(finalPrompt, /"step":1/u)
            assert.match(finalPrompt, /LATEST-TOOL-OBSERVATION/u)
            assert.match(finalPrompt, /user goal clipped by total prompt bound/u)
            assert.equal(brief.relevantPaths[0], "README.md")
        })
    })

    it("falls back when the research provider fails without losing bootstrap evidence", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "billing.ts"), "export const receipt = true\n")
            const bootstrap = new DeterministicRepositoryScanner(root)
            const expected = await bootstrap.scan(scanRequest(), new AbortController().signal)
            const scanner = new AutonomousRepositoryScanner(root, {
                bootstrapScanner: bootstrap,
                responder: {
                    backend: "claude",
                    async respond() {
                        throw new Error("provider unavailable")
                    },
                },
            })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.equal(brief.snapshotId, expected.snapshotId)
            assert.deepEqual(brief.relevantPaths, expected.relevantPaths)
            assert.match(brief.summary, /^Deterministic fallback\./u)
        })
    })

    it("refreshes a failed autonomous run instead of returning a stale fallback", async () => {
        await withRepository(async (root) => {
            const readme = join(root, "README.md")
            writeFileSync(readme, "authentication before provider failure\n")
            let mutated = false
            const scanner = new AutonomousRepositoryScanner(root, {
                responder: {
                    backend: "claude",
                    async respond() {
                        if (!mutated) {
                            mutated = true
                            writeFileSync(
                                readme,
                                "authentication after provider failure\n",
                            )
                        }
                        throw new Error("provider unavailable")
                    },
                },
            })

            const brief = await scanner.scan(scanRequest(), new AbortController().signal)
            const latest = await new DeterministicRepositoryScanner(root).scan(
                scanRequest(),
                new AbortController().signal,
            )

            assert.equal(brief.snapshotId, latest.snapshotId)
            assert.deepEqual(brief.relevantPaths, latest.relevantPaths)
            assert.match(brief.summary, /^Deterministic fallback\./u)
            assert.ok(brief.unknowns.includes(
                "The repository changed during autonomous research; model findings were discarded.",
            ))
        })
    })

    it("retains exhaustion diagnostics when the fallback rescan also detects drift", async () => {
        await withRepository(async (root) => {
            const readme = join(root, "README.md")
            writeFileSync(readme, "authentication before budget exhaustion\n")
            const scanner = new AutonomousRepositoryScanner(root, {
                maxObservationBytes: 1_024,
                maxTotalObservationBytes: 1_024,
                tools: fakeResearchTools({
                    read_file: () => {
                        writeFileSync(readme, "authentication after budget exhaustion\n")
                        return "x".repeat(1_024)
                    },
                }),
                responder: {
                    backend: "claude",
                    async respond(input) {
                        return JSON.stringify(decision(input, {
                            action: "read",
                            path: "README.md",
                        }))
                    },
                },
            })

            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.ok(brief.unknowns.includes(
                "Autonomous repository research exhausted its observation byte budget.",
            ))
            assert.ok(brief.unknowns.includes(
                "The repository changed during autonomous research; model findings were discarded.",
            ))
        })
    })

    it("marks fallback stability unknown when the mandatory final rescan fails", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "authentication evidence\n")
            const baseline = await new DeterministicRepositoryScanner(root).scan(
                scanRequest(),
                new AbortController().signal,
            )
            let scans = 0
            const scanner = new AutonomousRepositoryScanner(root, {
                bootstrapScanner: {
                    async scan() {
                        scans += 1
                        if (scans === 1) return baseline
                        throw new Error("repository rescan unavailable")
                    },
                },
                responder: {
                    backend: "claude",
                    async respond() {
                        throw new Error("provider unavailable")
                    },
                },
            })

            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.equal(scans, 2)
            assert.equal(brief.snapshotId, baseline.snapshotId)
            assert.equal(brief.truncated, true)
            assert.ok(brief.unknowns.includes(
                "The final repository stability rescan failed; fallback evidence may no longer match the checkout.",
            ))
        })
    })

    it("rescans before success and returns the latest fallback when the repository changed", async () => {
        await withRepository(async (root) => {
            const readme = join(root, "README.md")
            writeFileSync(readme, "authentication before research\n")
            let mutated = false
            const scanner = new AutonomousRepositoryScanner(root, {
                responder: {
                    backend: "codex",
                    async respond(input) {
                        if (!mutated) {
                            mutated = true
                            writeFileSync(readme, "authentication changed during research\n")
                        }
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "Model result belongs to the older snapshot.",
                            facts: [{
                                statement: "README was observed before it changed.",
                                evidencePath: "README.md",
                                confidence: "medium",
                            }],
                            relevantPaths: ["README.md"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)
            const latest = await new DeterministicRepositoryScanner(root).scan(
                scanRequest(),
                new AbortController().signal,
            )

            assert.equal(brief.snapshotId, latest.snapshotId)
            assert.match(brief.summary, /^Deterministic fallback\./u)
            assert.equal(brief.truncated, true)
            assert.ok(brief.unknowns.includes(
                "The repository changed during autonomous research; model findings were discarded.",
            ))
            assert.doesNotMatch(brief.summary, /older snapshot/u)
        })
    })

    it("replays model-visible evidence omitted by bootstrap before accepting success", async () => {
        await withRepository(async (root) => {
            const large = join(root, "large.ts")
            const before = "export const evidence = 'before'\n" + "x".repeat(300 * 1024)
            const after = "export const evidence = 'after!'\n" + "x".repeat(300 * 1024)
            assert.equal(Buffer.byteLength(before), Buffer.byteLength(after))
            writeFileSync(large, before)
            let changed = false
            const scanner = new AutonomousRepositoryScanner(root, {
                responder: {
                    backend: "codex",
                    async respond(input) {
                        if (input.step === 1) {
                            return JSON.stringify(decision(input, {
                                action: "glob",
                                pattern: "large.ts",
                            }))
                        }
                        if (input.step === 2) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: "large.ts",
                            }))
                        }
                        if (!changed) {
                            changed = true
                            writeFileSync(large, after)
                        }
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "The older large-file observation was accepted.",
                            facts: [{
                                statement: "The large file contains the before value.",
                                evidencePath: "large.ts",
                                line: 1,
                                confidence: "high",
                            }],
                            relevantPaths: ["large.ts"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })

            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.match(brief.summary, /^Deterministic fallback\./u)
            assert.doesNotMatch(brief.summary, /older large-file/u)
            assert.equal(brief.truncated, true)
            assert.ok(brief.unknowns.includes(
                "The repository changed during autonomous research; model findings were discarded.",
            ))
        })
    })

    it("requires discovery before reading an otherwise unobserved safe path", async () => {
        await withRepository(async (root) => {
            mkdirSync(join(root, "src"))
            writeFileSync(join(root, "README.md"), "repository entry point\n")
            writeFileSync(join(root, "src", "unmatched.ts"), "export const found = true\n")
            const calls: RepositoryScoutResponderInput[] = []
            const scanner = new AutonomousRepositoryScanner(root, {
                responder: {
                    backend: "claude",
                    async respond(input) {
                        calls.push(input)
                        if (input.step === 1 && input.attempt === 1) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: "src/unmatched.ts",
                            }))
                        }
                        if (input.step === 1) {
                            return JSON.stringify(decision(input, {
                                action: "glob",
                                pattern: "src/*.ts",
                            }))
                        }
                        if (input.step === 2) {
                            return JSON.stringify(decision(input, {
                                action: "read",
                                path: "src/unmatched.ts",
                            }))
                        }
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "The discovered source was inspected.",
                            facts: [{
                                statement: "The source exports found.",
                                evidencePath: "src/unmatched.ts",
                                line: 1,
                                confidence: "high",
                            }],
                            relevantPaths: ["src/unmatched.ts"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })

            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.deepEqual(calls.map((call) => [call.step, call.attempt]), [
                [1, 1],
                [1, 2],
                [2, 1],
                [3, 1],
            ])
            assert.match(calls[1]!.userPrompt, /unobserved file path/u)
            assert.equal(brief.summary, "The discovered source was inspected.")
        })
    })

    it("preserves Baro-owned safety unknowns ahead of full model lists", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "safety unknown fixture\n")
            const bootstrapScanner = {
                async scan() {
                    return {
                        schemaVersion: 1 as const,
                        snapshotId: `sha256:${"a".repeat(64)}`,
                        summary: "Bounded bootstrap.",
                        facts: [{
                            statement: "README was indexed.",
                            evidencePath: "README.md",
                            confidence: "medium" as const,
                        }],
                        relevantPaths: ["README.md"],
                        unknowns: Array.from(
                            { length: 16 },
                            (_, index) => `Bootstrap unknown ${index}.`,
                        ),
                        truncated: false,
                    }
                },
            }
            const scanner = new AutonomousRepositoryScanner(root, {
                bootstrapScanner,
                responder: {
                    backend: "claude",
                    async respond(input) {
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "Bounded autonomous finding.",
                            facts: [{
                                statement: "README remained observed.",
                                evidencePath: "README.md",
                                confidence: "medium",
                            }],
                            relevantPaths: ["README.md"],
                            unknowns: Array.from(
                                { length: 16 },
                                (_, index) => `Model unknown ${index}.`,
                            ),
                            truncated: false,
                        }))
                    },
                },
            })
            const autonomous = await scanner.scan(
                scanRequest(),
                new AbortController().signal,
            )
            assert.equal(
                autonomous.unknowns[0],
                "Repository behavior and build/test results were not executed or verified.",
            )
            assert.equal(autonomous.unknowns.length, 16)
            assert.equal(autonomous.truncated, true)

            const fallback = await scanner.scan(
                { ...scanRequest(), correlation: undefined },
                new AbortController().signal,
            )
            assert.equal(
                fallback.unknowns[0],
                "Autonomous repository research did not complete; deterministic bootstrap evidence was used.",
            )
            assert.equal(fallback.unknowns.length, 16)
        })
    })

    it("forces truncated safety provenance for tool failure, clipping, and limits", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "broker provenance fixture\n")
            const cases = [
                {
                    name: "failure",
                    action: { action: "read", path: "README.md" },
                    outputs: { read_file: "Error: synthetic read failure" },
                    expected:
                        "A requested read-only repository observation failed and may have left evidence incomplete.",
                },
                {
                    name: "clipping",
                    action: { action: "read", path: "README.md" },
                    outputs: { read_file: "x".repeat(2_000) },
                    expected:
                        "A repository observation was clipped by its configured output bound.",
                },
                {
                    name: "limit",
                    action: { action: "glob", pattern: "**/*.md" },
                    outputs: { glob: "README.md\n... (glob limit reached)" },
                    expected:
                        "A repository search or glob reached its configured work or result bound.",
                },
            ] as const

            for (const fixture of cases) {
                const responder: RepositoryScoutResponder = {
                    backend: "openai",
                    async respond(input) {
                        if (input.step === 1) {
                            return JSON.stringify(decision(input, fixture.action))
                        }
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: `Finished after broker ${fixture.name}.`,
                            facts: [{
                                statement: "README remained bootstrap-grounded.",
                                evidencePath: "README.md",
                                confidence: "medium",
                            }],
                            relevantPaths: ["README.md"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                }
                const scanner = new AutonomousRepositoryScanner(root, {
                    responder,
                    maxObservationBytes: 256,
                    maxTranscriptBytes: 1_024,
                    tools: fakeResearchTools(fixture.outputs),
                })
                const brief = await scanner.scan(
                    scanRequest(),
                    new AbortController().signal,
                )

                assert.equal(brief.truncated, true, fixture.name)
                assert.ok(brief.unknowns.includes(fixture.expected), fixture.name)
            }
        })
    })

    it("repairs canonical duplicate actions on the same step, then falls back", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "AUTH duplicate fixture\n")
            const calls: RepositoryScoutResponderInput[] = []
            let toolCalls = 0
            const tools = fakeResearchTools({
                grep: () => {
                    toolCalls += 1
                    return "README.md:1:AUTH duplicate fixture"
                },
            })
            const scanner = new AutonomousRepositoryScanner(root, {
                maxSteps: 20,
                tools,
                responder: {
                    backend: "claude",
                    async respond(input) {
                        calls.push(input)
                        return JSON.stringify(decision(input, {
                            action: "search",
                            pattern: input.step === 1 ? "AUTH" : "auth",
                            path: "",
                            filePattern: "*.md",
                        }))
                    },
                },
            })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.deepEqual(calls.map((call) => [call.step, call.attempt]), [
                [1, 1],
                [2, 1],
                [2, 2],
                [2, 3],
            ])
            assert.equal(toolCalls, 1)
            assert.match(calls[2]!.userPrompt, /repeated a no-progress action/u)
            assert.match(brief.summary, /^Deterministic fallback\./u)
            assert.equal(brief.truncated, true)
        })
    })

    it("repairs a malformed decision on the same step without discarding autonomy", async () => {
        await withRepository(async (root) => {
            writeFileSync(join(root, "README.md"), "authentication compatibility\n")
            const calls: RepositoryScoutResponderInput[] = []
            const scanner = new AutonomousRepositoryScanner(root, {
                responder: {
                    backend: "opencode",
                    async respond(input) {
                        calls.push(input)
                        if (input.attempt === 1) return "not-json"
                        return JSON.stringify(decision(input, {
                            action: "finish",
                            summary: "The repository entry point documents authentication.",
                            facts: [{
                                statement: "README mentions authentication compatibility.",
                                evidencePath: "README.md",
                                confidence: "medium",
                            }],
                            relevantPaths: ["README.md"],
                            unknowns: [],
                            truncated: false,
                        }))
                    },
                },
            })
            const brief = await scanner.scan(scanRequest(), new AbortController().signal)

            assert.deepEqual(calls.map((call) => [call.step, call.attempt]), [
                [1, 1],
                [1, 2],
            ])
            assert.match(calls[1]!.userPrompt, /PREVIOUS DECISION WAS REJECTED/)
            assert.match(brief.summary, /repository entry point/u)
            assert.equal(brief.truncated, false)
            assert.doesNotMatch(brief.summary, /^Deterministic fallback\./u)
        })
    })

    it("exposes no write/bash/network capability and excludes secrets and symlinks", async () => {
        await withRepository(async (root) => {
            mkdirSync(join(root, "src"))
            mkdirSync(join(root, ".aws"))
            writeFileSync(join(root, "src", "visible.ts"), "export const visible = 'TOKEN'\n")
            writeFileSync(join(root, ".env"), "TOKEN=environment-secret\n")
            writeFileSync(join(root, "credentials.json"), '{"token":"credential-secret"}\n')
            writeFileSync(join(root, "private.key"), "private-key-secret\n")
            writeFileSync(join(root, ".aws", "config"), "cloud-secret\n")
            const outside = join(tmpdir(), `baro-scout-outside-${process.pid}.ts`)
            writeFileSync(outside, "outside-secret\n")
            symlinkSync(outside, join(root, "linked.ts"))

            try {
                const tools = createReadOnlyRepositoryScoutTools(root)
                assert.deepEqual(tools.map((tool) => tool.name), [
                    "read_file",
                    "grep",
                    "glob",
                ])
                const byName = new Map(tools.map((tool) => [tool.name, tool]))
                const glob = String(await byName.get("glob")!.invoke({ pattern: "**/*" }))
                assert.match(glob, /src\/visible\.ts/)
                assert.doesNotMatch(
                    glob,
                    /\.env|credentials|private\.key|\.aws|linked\.ts/u,
                )
                assert.match(
                    String(await byName.get("read_file")!.invoke({ path: ".env" })),
                    /^Error:/u,
                )
                assert.match(
                    String(await byName.get("read_file")!.invoke({ path: "linked.ts" })),
                    /^Error:/u,
                )
                const search = String(await byName.get("grep")!.invoke({
                    pattern: "secret",
                    path: "",
                    file_pattern: "",
                }))
                assert.equal(search, "No matches found.")

                const scanner = new AutonomousRepositoryScanner(root, {
                    responder: {
                        backend: "pi",
                        async respond(input) {
                            return JSON.stringify({
                                schemaVersion: 1,
                                sessionId: input.sessionId,
                                requestId: input.requestId,
                                contextRequestId: input.contextRequestId,
                                step: input.step,
                                action: "write",
                                path: "created.ts",
                                content: "not allowed",
                            })
                        },
                    },
                })
                const brief = await scanner.scan(
                    scanRequest(),
                    new AbortController().signal,
                )
                assert.equal(existsSync(join(root, "created.ts")), false)
                assert.match(brief.summary, /^Deterministic fallback\./u)
            } finally {
                rmSync(outside, { force: true })
            }
        })
    })
})

function scanRequest() {
    return {
        query: "Inspect authentication and billing compatibility.",
        intent: "goal" as const,
        correlation: CORRELATION,
    }
}

function scriptedResponder(
    calls: RepositoryScoutResponderInput[],
    replies: ReadonlyArray<(input: RepositoryScoutResponderInput) => unknown>,
): RepositoryScoutResponder {
    return {
        backend: "codex",
        async respond(input) {
            calls.push(input)
            const reply = replies[input.step - 1]
            if (!reply) throw new Error("unexpected research step")
            return JSON.stringify(reply(input))
        },
    }
}

function decision(
    input: RepositoryScoutResponderInput,
    action: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    return {
        schemaVersion: 1,
        sessionId: input.sessionId,
        requestId: input.requestId,
        contextRequestId: input.contextRequestId,
        step: input.step,
        ...action,
    }
}

function fakeResearchTools(
    outputs: Readonly<Partial<Record<
        "read_file" | "grep" | "glob",
        string | (() => string)
    >>>,
): Tool[] {
    return (["read_file", "grep", "glob"] as const).map((name) => ({
        type: "function",
        name,
        description: `Provider-free fake ${name}`,
        strict: true,
        parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
        },
        async invoke() {
            const output = outputs[name] ?? "README.md"
            return typeof output === "function" ? output() : output
        },
    }))
}

async function withRepository(
    run: (root: string) => Promise<void>,
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "baro-autonomous-scout-"))
    try {
        await run(root)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}
