/**
 * Pi backend integration test: stream mapper (unit), then one-shot runner,
 * CLI participant, and story agent against a real `pi` process in a temp git
 * repo. Fixtures use Pi's real wire shapes — see docs/stream-protocols.md,
 * "Pi (pi-stream-mapper.ts)". Run with npx tsx; exits non-zero on failure.
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

import { mapPiEvent } from "../src/pi-stream-mapper.js"
import { PiCliParticipant } from "../src/participants/pi-cli-participant.js"
import { PiStoryAgent } from "../src/participants/pi-story-agent.js"
import { runPiOneShot } from "../src/pi-one-shot.js"

let testDir: string
let passed = 0
let failed = 0
let skipped = 0

function piAvailable(): boolean {
    try {
        execSync("command -v pi", { stdio: "ignore" })
        return true
    } catch {
        return false
    }
}

function setup(): void {
    testDir = mkdtempSync(join(tmpdir(), "baro-pi-test-"))
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

    // session — the only event carrying the session id (`event.id`).
    const sessionEvent = {
        type: "session",
        version: 3,
        id: "019e9d13-pi-session",
        timestamp: 1234,
        cwd: "/tmp/pi-probe",
    }
    const sessionResult = mapPiEvent("agent-1", sessionEvent)
    assert(sessionResult.sessionId === "019e9d13-pi-session", "extracts sessionId from session event")
    assert(sessionResult.items.length >= 1, "session produces items")

    // message_update with a text_delta — must NOT emit a ModelMessageItem
    // (final text comes from message_end), only a non-empty item.
    const deltaEvent = {
        type: "message_update",
        assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 1,
            delta: "Hello",
        },
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    }
    const deltaResult = mapPiEvent("agent-1", deltaEvent)
    assert(deltaResult.items.length >= 1, "message_update text_delta produces items")
    assert(
        !deltaResult.items.some((i) => i instanceof ModelMessageItem),
        "text_delta does NOT emit a ModelMessageItem (no dup with message_end)",
    )

    const messageEndEvent = {
        type: "message_end",
        message: {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "thinking..." },
                { type: "text", text: "Hello world" },
            ],
            usage: { input: 10, output: 5, totalTokens: 15 },
        },
    }
    const endResult = mapPiEvent("agent-1", messageEndEvent)
    const modelMsg = endResult.items.find(
        (item): item is ModelMessageItem => item instanceof ModelMessageItem,
    )
    const modelMsgText = modelMsg
        ? (JSON.parse(JSON.stringify(modelMsg)).content ?? [])
              .map((p: { text?: string }) => p.text ?? "")
              .join("")
        : undefined
    assert(
        modelMsgText === "Hello world",
        "message_end produces a ModelMessageItem with the correct text",
    )

    // Real toolCall block shape: {type:"toolCall",id,name,arguments}.
    const realCallId = "call_0a69297a"
    const toolCallEnd = {
        type: "message_end",
        message: {
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: realCallId,
                    name: "bash",
                    arguments: { command: "echo hello42" },
                },
            ],
        },
    }
    const toolCallResult = mapPiEvent("agent-1", toolCallEnd)
    const fnCall = toolCallResult.items.find(
        (i): i is FunctionCallItem => i instanceof FunctionCallItem,
    )
    assert(
        fnCall !== undefined,
        "message_end with a toolCall block produces a FunctionCallItem",
    )

    // Real tool_execution_end shape: {type, toolCallId, toolName,
    // result:{content:[{type:"text",text}]}, isError}. Its toolCallId equals
    // the toolCall block id from message_end — call and output must reconcile.
    const toolExecEnd = {
        type: "tool_execution_end",
        toolCallId: realCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: "hello42\n" }] },
        isError: false,
    }
    const execResult = mapPiEvent("agent-1", toolExecEnd)
    assert(execResult.items.length >= 1, "tool_execution_end produces items (not dropped)")
    const fnOut = execResult.items.find(
        (i): i is FunctionCallOutputItem =>
            i instanceof FunctionCallOutputItem,
    )
    assert(
        fnOut !== undefined,
        "tool_execution_end (real shape) emits a FunctionCallOutputItem",
    )

    // Load-bearing reconciliation: call.call_id === output.call_id === the real
    // toolCallId (a past bug read `callId`, never present, so no item was emitted).
    // NB: serialized Mozaik field is `call_id`; output is [{type:"input_text",text}].
    const callId = fnCall
        ? (JSON.parse(JSON.stringify(fnCall)).call_id as string | undefined)
        : undefined
    const outCallId = fnOut
        ? (JSON.parse(JSON.stringify(fnOut)).call_id as string | undefined)
        : undefined
    assert(
        callId === realCallId,
        `FunctionCallItem.call_id === ${realCallId} (got: ${callId})`,
    )
    assert(
        outCallId === realCallId,
        `FunctionCallOutputItem.call_id === ${realCallId} (got: ${outCallId})`,
    )
    assert(
        callId !== undefined && callId === outCallId,
        "call and output reconcile to the same call_id",
    )

    // Output text must come from result.content[].text, not a stringified result object.
    const outParts = fnOut
        ? (JSON.parse(JSON.stringify(fnOut)).output as
              | Array<{ text?: string }>
              | undefined)
        : undefined
    const outText = Array.isArray(outParts)
        ? outParts.map((p) => p.text ?? "").join("")
        : undefined
    assert(
        typeof outText === "string" && outText.includes("hello42"),
        `output text extracted from result.content[].text (got: ${outText})`,
    )

    // Regression (HIGH-1): an empty-but-successful tool result (bash with no
    // stdout) must STILL emit a reconciled FunctionCallOutputItem — not be
    // dropped or fall through to a stringified-envelope dump.
    const emptyOutEnd = {
        type: "tool_execution_end",
        toolCallId: realCallId,
        toolName: "bash",
        result: { content: [{ type: "text", text: "" }] },
        isError: false,
    }
    const emptyRes = mapPiEvent("agent-1", emptyOutEnd)
    const emptyFnOut = emptyRes.items.find(
        (i): i is FunctionCallOutputItem => i instanceof FunctionCallOutputItem,
    )
    assert(
        emptyFnOut !== undefined,
        "empty-success tool result still emits a FunctionCallOutputItem (HIGH-1)",
    )
    const emptyParts = emptyFnOut
        ? (JSON.parse(JSON.stringify(emptyFnOut)).output as
              | Array<{ text?: string }>
              | undefined)
        : undefined
    const emptyText = Array.isArray(emptyParts)
        ? emptyParts.map((p) => p.text ?? "").join("")
        : undefined
    assert(
        emptyText === "" && !String(emptyText).includes("content"),
        `empty result yields empty output, not a stringified envelope (got: ${JSON.stringify(emptyText)})`,
    )

    // Regression (HIGH-1): tool_execution_end with NO `result` field at all
    // (interrupted/cancelled/error path). The old emit guard dropped the
    // FunctionCallOutputItem here, orphaning the FunctionCallItem; fails on revert.
    const noBodyEnd = {
        type: "tool_execution_end",
        toolCallId: realCallId,
        toolName: "bash",
        isError: false,
    }
    const noBodyRes = mapPiEvent("agent-1", noBodyEnd)
    const noBodyFnOut = noBodyRes.items.find(
        (i): i is FunctionCallOutputItem => i instanceof FunctionCallOutputItem,
    )
    assert(
        noBodyFnOut !== undefined,
        "tool_execution_end with NO result field still emits a FunctionCallOutputItem (HIGH-1, fails on revert)",
    )

    // Regression (HIGH-1): same shape but isError → output must be the explicit
    // failure sentinel, not dropped ('no output' is only reachable with result absent).
    const errEnd = {
        type: "tool_execution_end",
        toolCallId: realCallId,
        toolName: "bash",
        isError: true,
    }
    const errRes = mapPiEvent("agent-1", errEnd)
    const errFnOut = errRes.items.find(
        (i): i is FunctionCallOutputItem => i instanceof FunctionCallOutputItem,
    )
    assert(
        errFnOut !== undefined,
        "errored tool_execution_end with no result still emits a FunctionCallOutputItem (HIGH-1, fails on revert)",
    )
    const errParts = errFnOut
        ? (JSON.parse(JSON.stringify(errFnOut)).output as
              | Array<{ text?: string }>
              | undefined)
        : undefined
    const errText = Array.isArray(errParts)
        ? errParts.map((p) => p.text ?? "").join("")
        : undefined
    assert(
        errText === "[error] no output",
        `errored no-result output is the explicit '[error] no output' sentinel (got: ${JSON.stringify(errText)})`,
    )

    // agent_end (loop-done signal).
    const agentEndEvent = { type: "agent_end", messages: [], willRetry: false }
    const agentEndResult = mapPiEvent("agent-1", agentEndEvent)
    assert(agentEndResult.items.length >= 1, "agent_end produces items")

    const unknownEvent = { type: "foobar", timestamp: 1239 }
    const unknownResult = mapPiEvent("agent-1", unknownEvent)
    assert(unknownResult.items.length >= 1, "unknown event produces items (not dropped)")
}

async function testOneShot(): Promise<void> {
    process.stderr.write("\n[test] 2. One-shot runner (live pi invocation)\n")

    try {
        const result = await runPiOneShot({
            prompt: 'Say exactly this text and nothing else: BARO_INTEGRATION_TEST_PASS',
            cwd: testDir,
            timeoutMs: 120_000,
            label: "test-oneshot",
        })
        assert(result.includes("BARO_INTEGRATION_TEST_PASS"), "one-shot returns expected text")
        assert(result.length > 0, "one-shot returns non-empty text")
    } catch (e) {
        assert(false, `one-shot threw: ${(e as Error).message}`)
    }
}

async function testCliParticipant(): Promise<void> {
    process.stderr.write("\n[test] 3. CLI participant (live pi invocation)\n")

    const env = new AgenticEnvironment()
    const participant = new PiCliParticipant("test-agent", {
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
    process.stderr.write("\n[test] 4. Story agent (live pi invocation)\n")

    // File-mutation prompt (not a prose echo) so the success predicate
    // (requires >=1 tool call) is exercised on a genuine task.
    const targetFile = "STORY_AGENT_OK.txt"
    const env = new AgenticEnvironment()
    const agent = new PiStoryAgent({
        id: "test-story-1",
        prompt: `Create a file named ${targetFile} in the current directory containing exactly the text DONE. Use your file-writing tools.`,
        cwd: testDir,
        retries: 0,
        timeoutSecs: 180,
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

// `pi` exits 0 even when the model just talks and does no work, so the
// success predicate must reject a zero-tool run — otherwise a refused/no-op
// story is a false PASS to the Conductor. Guards against exit-code-only regression.
async function testNoOpRejected(): Promise<void> {
    process.stderr.write("\n[test] 5. No-op story is rejected (regression guard)\n")

    const env = new AgenticEnvironment()
    const agent = new PiStoryAgent({
        id: "test-story-noop",
        prompt: "Reply with the single word ACKNOWLEDGED and do nothing else. Do not use any tools.",
        cwd: testDir,
        retries: 0,
        timeoutSecs: 120,
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
    process.stderr.write("═══ Pi Backend Integration Test ═══\n")

    setup()

    try {
        testStreamMapper()

        // Live tests need `pi` on PATH + a configured provider: SKIP (not fail)
        // when absent so CI doesn't conflate "not provisioned" with "regression".
        if (piAvailable()) {
            await testOneShot()
            await testCliParticipant()
            await testStoryAgent()
            await testNoOpRejected()
        } else {
            skipped += 4
            process.stderr.write(
                "\n[test] pi not found on PATH — SKIPPING live tests 2-5 " +
                    "(install pi and configure a provider to run them).\n",
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
