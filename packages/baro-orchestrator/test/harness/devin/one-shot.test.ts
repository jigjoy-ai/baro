import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { describe, it } from "node:test"

import { runDevinOneShot } from "../../../src/harness/devin/one-shot.js"
import { DevinCliParticipant } from "../../../src/harness/devin/cli-participant.js"
import { DevinTurnEvent } from "../../../src/semantic-events.js"
import type { UnsequencedRunnerInvocationObservation } from "../../../src/harness/runner-invocation.js"
import { captureEnv, withTempDir } from "../../execution/helpers.js"
import { writeFakeDevin } from "./fake-devin.js"

describe("runDevinOneShot", () => {
    it("returns the assistant text with turn token totals", async () => {
        await withTempDir("baro-devin-", async (dir) => {
            const observations: UnsequencedRunnerInvocationObservation[] = []
            const text = await runDevinOneShot({
                prompt: "hi",
                cwd: dir,
                devinBin: writeFakeDevin(dir, "text"),
                timeoutMs: 60_000,
                onInvocation: (o) => observations.push(o),
            })
            assert.equal(text, "Hello")
            const tokens = observations.at(-1)!.tokens
            assert.deepEqual(tokens.inputTotal, { state: "known", value: 100, source: "derived" })
            assert.deepEqual(tokens.cachedInput, { state: "known", value: 40, source: "cli_result" })
            assert.equal(observations.at(-1)!.resolvedModel, "SWE-2 Medium")
        })
    })

    it("runs a safe evaluator on the tool-less agent, in ask mode, in an isolated tool-denied directory", async () => {
        await withTempDir("baro-devin-", async (dir) => {
            const reply = JSON.parse(await runDevinOneShot({
                prompt: "judge this",
                cwd: dir,
                devinBin: writeFakeDevin(dir, "echo"),
                timeoutMs: 60_000,
                safeEvaluatorSystemPrompt: "You are a judge.",
            })) as { cwd: string; mode: string; isolated: boolean; agentType: string | null }
            assert.equal(reply.agentType, "summarizer")
            assert.equal(reply.mode, "ask")
            assert.equal(reply.isolated, true)
            assert.notEqual(reply.cwd, dir)
            assert.equal(existsSync(reply.cwd), false, "the isolated directory is removed afterwards")
        })
    })

    it("fails a safe evaluator that reaches for a tool", async () => {
        await withTempDir("baro-devin-", async (dir) => {
            await assert.rejects(
                runDevinOneShot({
                    prompt: "judge this",
                    cwd: dir,
                    devinBin: writeFakeDevin(dir, "tool"),
                    timeoutMs: 60_000,
                    safeEvaluatorSystemPrompt: "You are a judge.",
                }),
                /safe evaluator attempted a tool call/,
            )
        })
    })

    it("surfaces Devin's own reason when a session cannot open", async () => {
        await withTempDir("baro-devin-", async (dir) => {
            await assert.rejects(
                runDevinOneShot({ prompt: "hi", cwd: dir, devinBin: writeFakeDevin(dir, "auth"), timeoutMs: 60_000 }),
                /Service key has expired/,
            )
        })
    })
})

describe("DevinCliParticipant", () => {
    it("reports a finished turn with completed tool work", async () => {
        await withTempDir("baro-devin-", async (dir) => {
            const env = captureEnv()
            env.deliverFunctionCallOutput =
                (() => {}) as typeof env.deliverFunctionCallOutput
            const participant = new DevinCliParticipant("S1", { cwd: dir, prompt: "touch a", devinBin: writeFakeDevin(dir, "story") })
            participant.start(env)
            await participant.ready
            const summary = await participant.done
            assert.equal(summary.stopReason, "end_turn")
            assert.equal(summary.toolCallCount, 1)
            assert.equal(summary.toolSuccessCount, 1)
            assert.equal(summary.acpFailure, null)
            assert.equal(summary.exitCode, 0)
            assert.equal(participant.getPhase(), "done")
            const turnEnd = env.events.find(DevinTurnEvent.is)
            assert.deepEqual(turnEnd?.data.raw.usage, { input_tokens: 60, cached_input_tokens: 40, output_tokens: 5 })
        })
    })
})
