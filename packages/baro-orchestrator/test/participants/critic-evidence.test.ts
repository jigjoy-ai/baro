import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    FunctionCallItem,
    FunctionCallOutputItem,
    type Participant,
    type SemanticEvent,
} from "@mozaik-ai/core"

import {
    CRITIC_MAX_PROMPT_CHARS,
    CriticCommandEvidenceCollector,
    buildEvalPrompt,
    prepareCriticEvalPrompt,
    type CriticEvidenceSource,
} from "../../src/participants/critic-evidence.js"
import { CriticOpenAI } from "../../src/participants/critic-openai.js"
import { CriticOpenCode } from "../../src/participants/critic-opencode.js"
import { CriticPi } from "../../src/participants/critic-pi.js"
import { Critic, VERDICT_SYSTEM_PROMPT } from "../../src/participants/critic.js"
import { StoryOutcomeAuthority } from "../../src/runtime/story-outcome-authority.js"
import { AgentResult, AgentState } from "../../src/semantic-events.js"
import { joinWithCapture, source, withTempDir } from "./helpers.js"

interface TestCritic {
    onExternalEvent(source: Participant, event: SemanticEvent<unknown>): Promise<void>
    idle(): Promise<void>
    join: unknown
}

describe("Critic repository evidence", () => {
    it("feeds the same real diff/status and command evidence to every tool-less backend", async () => {
        await withTempDir("baro-critic-evidence-", async (repo) => {
            git(repo, "init", "--quiet")
            writeFileSync(join(repo, "tracked.ts"), "export const value = 1\n")
            git(repo, "add", "tracked.ts")
            git(
                repo,
                "-c",
                "user.name=Baro Test",
                "-c",
                "user.email=baro@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "baseline",
            )
            const baseSha = git(repo, "rev-parse", "HEAD").trim()
            const fsmonitorSentinel = join(repo, "fsmonitor-executed")
            const fsmonitor = join(repo, "hostile-fsmonitor.sh")
            writeFileSync(
                fsmonitor,
                `#!/bin/sh\nprintf executed > ${JSON.stringify(fsmonitorSentinel)}\n`,
            )
            chmodSync(fsmonitor, 0o755)
            git(repo, "config", "core.fsmonitor", fsmonitor)
            writeFileSync(join(repo, "tracked.ts"), "export const value = 2\n")
            writeFileSync(
                join(repo, "new-test.ts"),
                'test("new behavior", () => assert.equal(value, 2))\n',
            )
            writeFileSync(
                join(repo, ".env.local"),
                "BARO_DO_NOT_LEAK_ENV=super-secret-env-value\n",
            )
            writeFileSync(
                join(repo, "credentials.json"),
                '{"BARO_DO_NOT_LEAK_CREDENTIAL":"super-secret-json-value"}\n',
            )
            writeFileSync(
                join(repo, "artifact.bin"),
                "BARO_DO_NOT_LEAK_NON_SOURCE=opaque-value\n",
            )

            const commands = new CriticCommandEvidenceCollector({
                resolveRepositoryTarget: () => ({ cwd: repo, baseSha }),
            })
            commands.onExternalFunctionCall(
                source("agent-a"),
                FunctionCallItem.rehydrate({
                    callId: "test-command",
                    name: "Bash",
                    args: JSON.stringify({ command: "npm test -- --runInBand" }),
                }),
            )
            commands.onExternalFunctionCallOutput(
                source("agent-a"),
                FunctionCallOutputItem.create(
                    "test-command",
                    "22 test files passed; 192 tests passed",
                ),
            )

            const evidence: CriticEvidenceSource = {
                resolveRepositoryTarget: () => ({ cwd: repo, baseSha }),
                commandEvidence: (agentId) => commands.snapshot(agentId),
            }
            const captured: Array<{ backend: string; prompt: string }> = []
            const factories: Array<[string, () => TestCritic]> = [
                ["claude", () => new Critic({ targets: targets(), evidence })],
                [
                    "openai",
                    () => new CriticOpenAI({
                        targets: targets(),
                        model: "evidence-test-model",
                        evidence,
                    }),
                ],
                [
                    "opencode",
                    () => new CriticOpenCode({ targets: targets(), evidence }),
                ],
                ["pi", () => new CriticPi({ targets: targets(), evidence })],
            ]

            for (const [backend, factory] of factories) {
                const critic = factory()
                Object.defineProperty(critic, "evaluate", {
                    value: async (prompt: string) => {
                        captured.push({ backend, prompt })
                        return {
                            verdict: "pass",
                            reasoning: "evidence captured",
                            violatedCriteria: [],
                        }
                    },
                })
                joinWithCapture(critic)
                await critic.onExternalEvent(source("runner"), resultEvent())
                await critic.idle()
            }

            assert.deepEqual(
                captured.map(({ backend }) => backend),
                ["claude", "openai", "opencode", "pi"],
            )
            for (const { prompt } of captured) {
                assert.match(prompt, /UNTRUSTED SELF-REPORT/)
                assert.match(prompt, /Never accept a summary claim/)
                assert.match(prompt, /npm test -- --runInBand/)
                assert.match(prompt, /192 tests passed/)
                assert.match(prompt, new RegExp(baseSha))
                assert.match(prompt, /M tracked\.ts/)
                assert.match(prompt, /\?\? new-test\.ts/)
                assert.match(prompt, /\+export const value = 2/)
                assert.doesNotMatch(prompt, /new behavior/)
                assert.match(prompt, /\.env\.local/)
                assert.match(prompt, /credentials\.json/)
                assert.match(prompt, /artifact\.bin/)
                assert.doesNotMatch(prompt, /super-secret-env-value/)
                assert.doesNotMatch(prompt, /super-secret-json-value/)
                assert.doesNotMatch(prompt, /opaque-value/)
                assert.match(prompt, /untracked file metadata \(content never read\)/)
                assert.match(prompt, /content omitted by fail-closed untracked metadata policy/)
                assert.match(prompt, /git diff --no-ext-diff --no-textconv --check/)
                assert.match(prompt, /I changed everything and all tests pass/)
            }
            assert.ok(
                captured.every(({ prompt }) => prompt === captured[0]!.prompt),
                "all tool-less Critic backends must receive the identical evidence prompt",
            )
            assert.equal(
                existsSync(fsmonitorSentinel),
                false,
                "Critic git evidence must disable repository-configured fsmonitor helpers",
            )
        })
    })

    it("makes summary distrust an explicit system-level verdict rule", () => {
        assert.match(VERDICT_SYSTEM_PROMPT, /self-report/)
        assert.match(VERDICT_SYSTEM_PROMPT, /Never treat its claims as evidence/)
        assert.match(VERDICT_SYSTEM_PROMPT, /tests\/build\/lint/)
        assert.match(VERDICT_SYSTEM_PROMPT, /marked STALE/)
    })

    it("marks test evidence stale after a later native write or edit in non-git fallback", async () => {
        const collector = new CriticCommandEvidenceCollector()
        collector.onExternalFunctionCall(
            source("agent-a"),
            FunctionCallItem.rehydrate({
                callId: "tests-before-edit",
                name: "shell",
                args: JSON.stringify({ command: "npm test" }),
            }),
        )
        collector.onExternalFunctionCallOutput(
            source("agent-a"),
            FunctionCallOutputItem.create("tests-before-edit", "192 tests passed"),
        )
        collector.onExternalFunctionCall(
            source("agent-a"),
            FunctionCallItem.rehydrate({
                callId: "later-edit",
                name: "edit_file",
                args: JSON.stringify({ path: "src/feature.ts" }),
            }),
        )

        const snapshot = await collector.snapshot("agent-a")
        assert.ok(snapshot)
        assert.match(snapshot, /npm test/)
        assert.match(snapshot, /freshness: STALE/)
        assert.match(snapshot, /non-git revision 1/)
        assert.match(snapshot, /advanced it to 2/)
    })

    it("marks earlier test evidence stale after any later shell call in non-git fallback", async () => {
        const collector = new CriticCommandEvidenceCollector()
        collector.onExternalFunctionCall(
            source("agent-a"),
            FunctionCallItem.rehydrate({
                callId: "tests-first",
                name: "bash",
                args: JSON.stringify({ command: "npm test" }),
            }),
        )
        collector.onExternalFunctionCallOutput(
            source("agent-a"),
            FunctionCallOutputItem.create("tests-first", "192 tests passed"),
        )
        collector.onExternalFunctionCall(
            source("agent-a"),
            FunctionCallItem.rehydrate({
                callId: "possible-shell-write",
                name: "shell",
                args: JSON.stringify({
                    command: "node scripts/regenerate-fixtures.js",
                }),
            }),
        )
        collector.onExternalFunctionCallOutput(
            source("agent-a"),
            FunctionCallOutputItem.create(
                "possible-shell-write",
                "fixtures regenerated",
            ),
        )

        const snapshot = await collector.snapshot("agent-a")
        assert.ok(snapshot)
        assert.match(
            snapshot,
            /### Command 2[\s\S]*fresh at conservative non-git revision 2[\s\S]*### Command 1[\s\S]*npm test[\s\S]*freshness: STALE/,
        )
    })

    it("keeps verification fresh across git metadata commits but stales it after byte changes", async () => {
        await withTempDir("baro-critic-fingerprint-", async (repo) => {
            git(repo, "init", "--quiet")
            writeFileSync(join(repo, "feature.ts"), "export const value = 1\n")
            git(repo, "add", "feature.ts")
            git(
                repo,
                "-c",
                "user.name=Baro Test",
                "-c",
                "user.email=baro@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "baseline",
            )
            const baseSha = git(repo, "rev-parse", "HEAD").trim()
            writeFileSync(join(repo, "feature.ts"), "export const value = 2\n")

            const collector = new CriticCommandEvidenceCollector({
                resolveRepositoryTarget: () => ({ cwd: repo, baseSha }),
            })
            collector.onExternalFunctionCall(
                source("agent-a"),
                FunctionCallItem.rehydrate({
                    callId: "verified-state",
                    name: "bash",
                    args: JSON.stringify({ command: "npm test" }),
                }),
            )
            collector.onExternalFunctionCallOutput(
                source("agent-a"),
                FunctionCallOutputItem.create(
                    "verified-state",
                    "192 tests passed",
                ),
            )

            assert.match(
                (await collector.snapshot("agent-a")) ?? "",
                /freshness: fresh: changed-content fingerprint/,
            )

            git(repo, "add", "feature.ts")
            git(
                repo,
                "-c",
                "user.name=Baro Test",
                "-c",
                "user.email=baro@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "implement feature",
            )
            assert.match(
                (await collector.snapshot("agent-a")) ?? "",
                /freshness: fresh: changed-content fingerprint/,
                "git index and commit metadata must not invalidate identical bytes",
            )

            writeFileSync(join(repo, "feature.ts"), "export const value = 3\n")
            assert.match(
                (await collector.snapshot("agent-a")) ?? "",
                /freshness: STALE: changed-content fingerprint no longer matches/,
            )
        })
    })

    it("never marks pre-edit tests fresh when workspace activity races fingerprint capture", async () => {
        await withTempDir("baro-critic-fingerprint-race-", async (repo) => {
            git(repo, "init", "--quiet")
            writeFileSync(join(repo, "feature.ts"), "export const value = 1\n")
            git(repo, "add", "feature.ts")
            git(
                repo,
                "-c",
                "user.name=Baro Test",
                "-c",
                "user.email=baro@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "baseline",
            )
            const baseSha = git(repo, "rev-parse", "HEAD").trim()

            let releaseResolver!: () => void
            const resolverGate = new Promise<void>((resolve) => {
                releaseResolver = resolve
            })
            let signalResolverStarted!: () => void
            const resolverStarted = new Promise<void>((resolve) => {
                signalResolverStarted = resolve
            })
            let delayFirstResolution = true
            const collector = new CriticCommandEvidenceCollector({
                resolveRepositoryTarget: async () => {
                    if (delayFirstResolution) {
                        delayFirstResolution = false
                        signalResolverStarted()
                        await resolverGate
                    }
                    return { cwd: repo, baseSha }
                },
            })
            collector.onExternalFunctionCall(
                source("agent-a"),
                FunctionCallItem.rehydrate({
                    callId: "tests-before-racing-edit",
                    name: "bash",
                    args: JSON.stringify({ command: "npm test" }),
                }),
            )
            collector.onExternalFunctionCallOutput(
                source("agent-a"),
                FunctionCallOutputItem.create(
                    "tests-before-racing-edit",
                    "192 tests passed",
                ),
            )

            await resolverStarted
            collector.onExternalFunctionCall(
                source("agent-a"),
                FunctionCallItem.rehydrate({
                    callId: "racing-edit",
                    name: "edit_file",
                    args: JSON.stringify({ path: "feature.ts" }),
                }),
            )
            releaseResolver()

            const snapshot = (await collector.snapshot("agent-a")) ?? ""
            assert.match(
                snapshot,
                /freshness: STALE\/UNVERIFIABLE: command fingerprint failed/,
            )
            assert.match(
                snapshot,
                /shell\/write activity advanced while the command fingerprint was being captured/,
            )
        })
    })

    it("marks command evidence unverifiable when a configured repository fingerprint fails", async () => {
        const collector = new CriticCommandEvidenceCollector({
            resolveRepositoryTarget: () => ({
                cwd: "/definitely/not/a/baro/repository",
                baseSha: "missing",
            }),
        })
        collector.onExternalFunctionCall(
            source("agent-a"),
            FunctionCallItem.rehydrate({
                callId: "unverifiable-tests",
                name: "bash",
                args: JSON.stringify({ command: "npm test" }),
            }),
        )
        collector.onExternalFunctionCallOutput(
            source("agent-a"),
            FunctionCallOutputItem.create(
                "unverifiable-tests",
                "192 tests passed",
            ),
        )
        assert.match(
            (await collector.snapshot("agent-a")) ?? "",
            /freshness: STALE\/UNVERIFIABLE:/,
        )
    })

    it("fails fingerprinting closed when a changed path has a symlink parent", async () => {
        await withTempDir("baro-critic-symlink-repo-", async (repo) => {
            await withTempDir("baro-critic-symlink-outside-", async (outside) => {
                git(repo, "init", "--quiet")
                mkdirSync(join(repo, "nested"))
                writeFileSync(join(repo, "nested", "feature.ts"), "safe\n")
                git(repo, "add", "nested/feature.ts")
                git(
                    repo,
                    "-c",
                    "user.name=Baro Test",
                    "-c",
                    "user.email=baro@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "baseline",
                )
                const baseSha = git(repo, "rev-parse", "HEAD").trim()
                writeFileSync(join(outside, "feature.ts"), "outside-secret\n")

                const collector = new CriticCommandEvidenceCollector({
                    resolveRepositoryTarget: () => ({ cwd: repo, baseSha }),
                })
                collector.onExternalFunctionCall(
                    source("agent-a"),
                    FunctionCallItem.rehydrate({
                        callId: "tests-before-symlink",
                        name: "bash",
                        args: JSON.stringify({ command: "npm test" }),
                    }),
                )
                collector.onExternalFunctionCallOutput(
                    source("agent-a"),
                    FunctionCallOutputItem.create(
                        "tests-before-symlink",
                        "tests passed",
                    ),
                )
                await collector.snapshot("agent-a")

                rmSync(join(repo, "nested"), { recursive: true })
                symlinkSync(outside, join(repo, "nested"), "dir")
                assert.match(
                    (await collector.snapshot("agent-a")) ?? "",
                    /STALE\/UNVERIFIABLE: current workspace fingerprint failed/,
                )
            })
        })
    })

    it("redacts provider credentials before command evidence is retained", async () => {
        const collector = new CriticCommandEvidenceCollector()
        const previous = process.env.OPENAI_API_KEY
        const secret = "sk-baro-critic-evidence-sentinel-123456"
        process.env.OPENAI_API_KEY = secret
        try {
            collector.onExternalFunctionCall(
                source("agent-a"),
                FunctionCallItem.rehydrate({
                    callId: "secret-command",
                    name: "bash",
                    args: JSON.stringify({
                        command: `curl -H 'Authorization: Bearer ${secret}'`,
                    }),
                }),
            )
            collector.onExternalFunctionCallOutput(
                source("agent-a"),
                FunctionCallOutputItem.create(
                    "secret-command",
                    `OPENAI_API_KEY=${secret}`,
                ),
            )
            const snapshot = await collector.snapshot("agent-a")
            assert.ok(snapshot)
            assert.doesNotMatch(snapshot, new RegExp(secret))
            assert.match(snapshot, /REDACTED/)
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY
            else process.env.OPENAI_API_KEY = previous
        }
    })

    it("redacts credentials from every cross-provider prompt section before bounding", async () => {
        await withTempDir("baro-critic-redaction-", async (repo) => {
            const previous = process.env.OPENAI_API_KEY
            const secret = "sk-baro-cross-provider-sentinel-123456789"
            process.env.OPENAI_API_KEY = secret
            try {
                git(repo, "init", "--quiet")
                writeFileSync(join(repo, "base.ts"), "export const base = 1\n")
                git(repo, "add", "base.ts")
                git(
                    repo,
                    "-c",
                    "user.name=Baro Test",
                    "-c",
                    "user.email=baro@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "baseline",
                )
                const baseSha = git(repo, "rev-parse", "HEAD").trim()
                writeFileSync(
                    join(repo, "tracked-secret.ts"),
                    `export const credential = "${secret}"\n`,
                )
                git(repo, "add", "tracked-secret.ts")
                git(
                    repo,
                    "-c",
                    "user.name=Baro Test",
                    "-c",
                    "user.email=baro@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    `record ${secret}`,
                )
                writeFileSync(
                    join(repo, `untracked-${secret}.txt`),
                    "metadata only\n",
                )

                const prompt = await prepareCriticEvalPrompt(
                    [`criterion mentions ${secret}`],
                    `agent output leaked ${secret}`,
                    "agent-a",
                    {
                        resolveRepositoryTarget: () => ({ cwd: repo, baseSha }),
                        commandEvidence: () =>
                            `command/output leaked ${secret}${"x".repeat(20_000)}`,
                    },
                )
                assert.doesNotMatch(prompt, new RegExp(secret))
                assert.match(prompt, /REDACTED/)
                assert.match(prompt, /tracked-secret\.ts/)
                assert.match(prompt, /characters omitted by Critic evidence bound/)
            } finally {
                if (previous === undefined) delete process.env.OPENAI_API_KEY
                else process.env.OPENAI_API_KEY = previous
            }
        })
    })

    it("does not carry command evidence across execution attempts", async () => {
        const collector = new CriticCommandEvidenceCollector()
        collector.onExternalFunctionCall(
            source("agent-a"),
            FunctionCallItem.rehydrate({
                callId: "old-attempt-tests",
                name: "bash",
                args: JSON.stringify({ command: "npm test" }),
            }),
        )
        collector.onExternalFunctionCallOutput(
            source("agent-a"),
            FunctionCallOutputItem.create("old-attempt-tests", "tests passed"),
        )
        assert.ok(await collector.snapshot("agent-a"))

        collector.onExternalEvent(
            source("agent-a"),
            AgentState.create({
                agentId: "agent-a",
                phase: "running",
                detail: "attempt 2",
            }),
        )
        assert.equal(await collector.snapshot("agent-a"), null)
    })

    it("rejects forged command evidence and attempt resets in collective mode", async () => {
        const authority = new StoryOutcomeAuthority("run-1")
        const worker = source("agent-a")
        const attacker = source("agent-a")
        authority.registerResultAuthority({
            runId: "run-1",
            storyId: "agent-a",
            leaseId: "lease-1",
            generation: 1,
        }, worker)
        const collector = new CriticCommandEvidenceCollector({
            outcomeAuthority: authority,
        })

        collector.onExternalFunctionCall(
            attacker,
            FunctionCallItem.rehydrate({
                callId: "forged-tests",
                name: "bash",
                args: JSON.stringify({ command: "echo '999 tests passed'" }),
            }),
        )
        assert.equal(await collector.snapshot("agent-a"), null)

        collector.onExternalFunctionCall(
            worker,
            FunctionCallItem.rehydrate({
                callId: "real-tests",
                name: "bash",
                args: JSON.stringify({ command: "npm test" }),
            }),
        )
        collector.onExternalFunctionCallOutput(
            worker,
            FunctionCallOutputItem.create("real-tests", "192 tests passed"),
        )
        assert.match((await collector.snapshot("agent-a")) ?? "", /192 tests passed/)

        collector.onExternalEvent(
            attacker,
            AgentState.create({
                agentId: "agent-a",
                phase: "running",
                detail: "attempt 2",
            }),
        )
        assert.match((await collector.snapshot("agent-a")) ?? "", /192 tests passed/)

        collector.onExternalEvent(
            worker,
            AgentState.create({
                agentId: "agent-a",
                phase: "running",
                detail: "attempt 2",
            }),
        )
        assert.equal(await collector.snapshot("agent-a"), null)
    })

    it("bounds untrusted evidence without truncating acceptance policy", () => {
        const prompt = buildEvalPrompt(
            ["criterion-one-remains-complete", "criterion-two-remains-complete"],
            `result-start-${"r".repeat(80_000)}-result-end`,
            `command-start-${"m".repeat(80_000)}-command-end`,
            `repository-start-${"d".repeat(160_000)}-repository-end`,
        )

        assert.ok(prompt.length <= CRITIC_MAX_PROMPT_CHARS)
        assert.match(prompt, /1\. criterion-one-remains-complete/)
        assert.match(prompt, /2\. criterion-two-remains-complete/)
        assert.match(prompt, /result-start-/)
        assert.match(prompt, /result-end/)
        assert.match(prompt, /characters omitted by Critic evidence bound/)
    })

    it("fails closed instead of silently omitting oversized acceptance criteria", () => {
        assert.throws(
            () => buildEvalPrompt(
                [`criterion-start-${"c".repeat(3_000)}-criterion-end`],
                "result",
            ),
            /lossless prompt budget; refusing partial evaluation/,
        )
        assert.throws(
            () => buildEvalPrompt(
                Array.from(
                    { length: 9 },
                    (_, index) => `criterion-${index}-${"x".repeat(1_000)}`,
                ),
                "result",
            ),
            /lossless prompt budget; refusing partial evaluation/,
        )
    })
})

function targets(): Map<string, readonly string[]> {
    return new Map([
        ["agent-a", ["implementation exists", "all tests pass"]],
    ])
}

function resultEvent(): ReturnType<typeof AgentResult.create> {
    return AgentResult.create({
        agentId: "agent-a",
        subtype: "success",
        sessionId: "session-a",
        isError: false,
        resultText: "I changed everything and all tests pass",
        usage: null,
        totalCostUsd: null,
        numTurns: 1,
        durationMs: null,
    })
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" })
}
