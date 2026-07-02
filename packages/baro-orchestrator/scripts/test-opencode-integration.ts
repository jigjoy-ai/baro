/**
 * OpenCode backend integration test: stream mapper (unit), then one-shot
 * runner, CLI participant, and story agent against a real `opencode` process
 * in a temp git repo. Fixtures use OpenCode's real wire shapes — see
 * docs/stream-protocols.md, "OpenCode (opencode-stream-mapper.ts)".
 * Run with npx tsx; exits non-zero on failure.
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"
import { tmpdir } from "os"

import {
    AgenticEnvironment,
    FunctionCallItem,
    FunctionCallOutputItem,
    ModelMessageItem,
} from "@mozaik-ai/core"

import { mapOpenCodeEvent } from "../src/opencode-stream-mapper.js"
import { OpenCodeCliParticipant } from "../src/participants/opencode-cli-participant.js"
import { OpenCodeStoryAgent } from "../src/participants/opencode-story-agent.js"
import { runOpenCodeOneShot } from "../src/opencode-one-shot.js"

let testDir: string
let passed = 0
let failed = 0
let skipped = 0

function opencodeAvailable(): boolean {
    try {
        execSync("command -v opencode", { stdio: "ignore" })
        return true
    } catch {
        return false
    }
}

function setup(): void {
    testDir = mkdtempSync(join(tmpdir(), "baro-opencode-test-"))
    execSync("git init", { cwd: testDir, stdio: "ignore" })
    writeFileSync(join(testDir, "README.md"), "# Integration test project\n")
    execSync("git add . && git commit -m 'init'", {
        cwd: testDir,
        stdio: "ignore",
    })
    process.stderr.write(`[test] temp dir: ${testDir}\n`)
}

function teardown(): void {
    try {
        rmSync(testDir, { recursive: true, force: true })
    } catch {
        // best-effort
    }
}

function assert(condition: boolean, msg: string): void {
    if (condition) {
        passed++
        process.stderr.write(`  ✓ ${msg}\n`)
    } else {
        failed++
        process.stderr.write(`  ✗ FAIL: ${msg}\n`)
    }
}

function testStreamMapper(): void {
    process.stderr.write("\n[test] 1. Stream mapper\n")

    const startEvent = {
        type: "step_start",
        timestamp: 1234,
        sessionID: "ses_test123",
        part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_test123", type: "step-start" },
    }
    const startResult = mapOpenCodeEvent("agent-1", startEvent)
    assert(startResult.sessionId === "ses_test123", "extracts sessionId")
    assert(startResult.items.length >= 1, "step_start produces items")

    const textEvent = {
        type: "text",
        timestamp: 1235,
        sessionID: "ses_test123",
        part: { id: "prt_2", messageID: "msg_1", sessionID: "ses_test123", type: "text", text: "Hello world" },
    }
    const textResult = mapOpenCodeEvent("agent-1", textEvent)
    assert(textResult.items.length >= 1, "text event produces items")
    // Assert an actual ModelMessageItem — a stringified substring match would
    // also pass if "Hello world" landed in another item's raw passthrough.
    // ModelMessageItem keeps its text in content[].text, not a top-level field.
    const modelMsg = textResult.items.find(
        (item): item is ModelMessageItem => item instanceof ModelMessageItem,
    )
    const modelMsgText = modelMsg
        ? (JSON.parse(JSON.stringify(modelMsg)).content ?? [])
              .map((p: { text?: string }) => p.text ?? "")
              .join("")
        : undefined
    assert(
        modelMsgText === "Hello world",
        "text event produces a ModelMessageItem with the correct text",
    )

    // Real opencode tool_use shape: one event carrying both the call
    // (state.input) and result (state.output) — must yield a FunctionCallItem
    // AND a FunctionCallOutputItem.
    const toolUseEvent = {
        type: "tool_use",
        timestamp: 1236,
        sessionID: "ses_test123",
        part: {
            type: "tool",
            tool: "write",
            callID: "tooluse_abc",
            state: {
                status: "completed",
                input: { filePath: "/tmp/test.txt", content: "hi" },
                output: "(no output)",
            },
        },
    }
    const toolUseResult = mapOpenCodeEvent("agent-1", toolUseEvent)
    assert(toolUseResult.items.length >= 1, "tool_use event produces items")
    assert(
        toolUseResult.items.some((i) => i instanceof FunctionCallItem),
        "tool_use produces a FunctionCallItem (real opencode shape)",
    )
    assert(
        toolUseResult.items.some((i) => i instanceof FunctionCallOutputItem),
        "completed tool_use produces a FunctionCallOutputItem",
    )

    // Legacy fallback shape must still map.
    const toolCallEvent = {
        type: "tool_call",
        timestamp: 1237,
        sessionID: "ses_test123",
        part: { id: "call_1", type: "tool-call", tool: "Read", args: { path: "/tmp/test.txt" } },
    }
    const toolResult = mapOpenCodeEvent("agent-1", toolCallEvent)
    assert(
        toolResult.items.some((i) => i instanceof FunctionCallItem),
        "legacy tool_call event still maps to a FunctionCallItem",
    )

    const finishEvent = {
        type: "step_finish",
        timestamp: 1238,
        sessionID: "ses_test123",
        part: {
            id: "prt_3", type: "step-finish", reason: "stop",
            tokens: { total: 100, input: 90, output: 10, reasoning: 0 },
            cost: 0.001,
        },
    }
    const finishResult = mapOpenCodeEvent("agent-1", finishEvent)
    assert(finishResult.items.length >= 1, "step_finish produces items")

    const unknownEvent = { type: "foobar", timestamp: 1239, sessionID: "ses_test123" }
    const unknownResult = mapOpenCodeEvent("agent-1", unknownEvent)
    assert(unknownResult.items.length >= 1, "unknown event produces items (not dropped)")
}

async function testOneShot(): Promise<void> {
    process.stderr.write("\n[test] 2. One-shot runner (live opencode invocation)\n")

    try {
        const result = await runOpenCodeOneShot({
            prompt: 'Say exactly this text and nothing else: BARO_INTEGRATION_TEST_PASS',
            cwd: testDir,
            timeoutMs: 60_000,
            label: "test-oneshot",
        })
        assert(result.includes("BARO_INTEGRATION_TEST_PASS"), "one-shot returns expected text")
        assert(result.length > 0, "one-shot returns non-empty text")
    } catch (e) {
        assert(false, `one-shot threw: ${(e as Error).message}`)
    }
}

async function testCliParticipant(): Promise<void> {
    process.stderr.write("\n[test] 3. CLI participant (live opencode invocation)\n")

    const env = new AgenticEnvironment()
    const participant = new OpenCodeCliParticipant("test-agent", {
        cwd: testDir,
        prompt: 'Say exactly: CLI_PARTICIPANT_OK',
    })

    participant.join(env)
    participant.start(env)

    try {
        await participant.ready
        assert(true, "participant becomes ready")
        assert(participant.getPhase() === "running", `phase is running (got: ${participant.getPhase()})`)
    } catch (e) {
        assert(false, `participant.ready rejected: ${(e as Error).message}`)
    }

    const summary = await participant.done
    assert(summary.exitCode === 0, `exit code is 0 (got: ${summary.exitCode})`)
    assert(summary.error === null, "no error on summary")
    assert(participant.getPhase() === "done", `final phase is done (got: ${participant.getPhase()})`)

    participant.leave(env)
}

async function testStoryAgent(): Promise<void> {
    process.stderr.write("\n[test] 4. Story agent (live opencode invocation)\n")

    // File-mutation prompt (not a prose echo) so the success predicate
    // (requires >=1 tool call) is exercised on a genuine task.
    const targetFile = "STORY_AGENT_OK.txt"
    const env = new AgenticEnvironment()
    const agent = new OpenCodeStoryAgent({
        id: "test-story-1",
        prompt: `Create a file named ${targetFile} in the current directory containing exactly the text DONE. Use your file-writing tools.`,
        cwd: testDir,
        retries: 0,
        timeoutSecs: 120,
    })

    agent.join(env)
    const outcome = await agent.run(env)

    assert(outcome.success === true, `story succeeded (got: ${outcome.success}, error: ${outcome.error})`)
    assert(outcome.attempts === 1, `completed in 1 attempt (got: ${outcome.attempts})`)
    assert(outcome.error === null, "no error in outcome")
    assert(outcome.durationSecs >= 0, "duration is non-negative")
    // The whole point of a story: the worktree changed.
    assert(
        existsSync(join(testDir, targetFile)),
        `story agent actually created ${targetFile} in the worktree`,
    )

    agent.leave(env)
}

// `opencode run` exits 0 even when the model just talks and does no work, so
// the success predicate must reject a zero-tool run — otherwise a refused/no-op
// story is a false PASS to the Conductor. Guards against exit-code-only regression.
async function testNoOpRejected(): Promise<void> {
    process.stderr.write("\n[test] 5. No-op story is rejected (regression guard)\n")

    const env = new AgenticEnvironment()
    const agent = new OpenCodeStoryAgent({
        id: "test-story-noop",
        prompt: "Reply with the single word ACKNOWLEDGED and do nothing else. Do not use any tools.",
        cwd: testDir,
        retries: 0,
        timeoutSecs: 60,
    })

    agent.join(env)
    const outcome = await agent.run(env)

    assert(
        outcome.success === false,
        `no-op (zero-tool) story is NOT marked passed (got success=${outcome.success})`,
    )
    assert(
        outcome.error != null,
        "no-op story carries a reason for the non-pass",
    )

    agent.leave(env)
}

async function main(): Promise<void> {
    process.stderr.write("═══ OpenCode Backend Integration Test ═══\n")

    setup()

    try {
        testStreamMapper()

        // Live tests need `opencode` on PATH + a configured provider: SKIP (not
        // fail) when absent so CI doesn't conflate "not provisioned" with "regression".
        if (opencodeAvailable()) {
            await testOneShot()
            await testCliParticipant()
            await testStoryAgent()
            await testNoOpRejected()
        } else {
            skipped += 4
            process.stderr.write(
                "\n[test] opencode not found on PATH — SKIPPING live tests 2-4 " +
                    "(install opencode and configure a provider to run them).\n",
            )
        }
    } finally {
        teardown()
    }

    process.stderr.write(
        `\n═══ Results: ${passed} passed, ${failed} failed, ${skipped} skipped ═══\n`,
    )

    if (failed > 0) {
        process.exit(1)
    }
    process.stderr.write(
        skipped > 0
            ? "Unit tests passed (live tests skipped).\n"
            : "All tests passed.\n",
    )
}

main().catch((e) => {
    process.stderr.write(`FATAL: ${(e as Error).message}\n`)
    process.exit(2)
})
