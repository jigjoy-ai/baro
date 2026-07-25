import assert from "node:assert/strict"
import { describe, it } from "node:test"

process.env.BARO_RUNNER_LIBRARY_ONLY = "1"

const {
    RUNNER_MAX_CONCURRENT_RUNS,
    RUNNER_PROTOCOL_FEATURES,
    RUNNER_PROTOCOL_VERSION,
    RunnerProtocolController,
    buildRunArgs,
} = await import("../scripts/runner.js")

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("bundled runner v2 protocol", () => {
    it("advertises the additive single-run conversation contract", () => {
        assert.equal(RUNNER_PROTOCOL_VERSION, 2)
        assert.equal(RUNNER_MAX_CONCURRENT_RUNS, 1)
        assert.deepEqual([...RUNNER_PROTOCOL_FEATURES], [
            "run_scoped_commands",
            "command_ack",
            "run_conversation",
        ])
    })

    it("makes collective coordination explicit for every current runner dispatch", () => {
        const args = buildRunArgs({
            t: "dispatch_run",
            runId: "run-args",
            goal: "build it",
            workspaceId: "default",
            parallel: 3,
            timeoutSecs: 60,
        }, "/tmp/work")
        assert.deepEqual(args.slice(args.indexOf("--coordination"), args.indexOf("--coordination") + 2), [
            "--coordination",
            "collective",
        ])
        assert.ok(!args.includes("--with-dialogue"))
        assert.ok(buildRunArgs({
            t: "dispatch_run",
            runId: "run-chat",
            goal: "build it",
            workspaceId: "default",
            parallel: 3,
            timeoutSecs: 60,
            conversation: true,
        }, "/tmp/work").includes("--with-dialogue"))
    })

    it("scopes events and commands, deduplicates messages, and rejects concurrent runs", async () => {
        const sent: Array<Record<string, unknown>> = []
        const writes: string[] = []
        const signals: AbortSignal[] = []
        let executions = 0
        let finish!: (outcome: { success: boolean; durationSecs: number; error: string | null }) => void
        const outcome = new Promise<{ success: boolean; durationSecs: number; error: string | null }>((resolve) => {
            finish = resolve
        })
        const sink = {
            writable: true,
            destroyed: false,
            write(data: string, callback?: (error?: Error | null) => void) {
                writes.push(data)
                callback?.()
                return true
            },
        }
        const controller = new RunnerProtocolController(
            (message) => sent.push(message as Record<string, unknown>),
            async (dispatch, emit, signal, bindCommandSink) => {
                executions++
                signals.push(signal)
                bindCommandSink(dispatch.runId, sink)
                emit({ type: "story_start", agentId: "S1", data: { id: "S1" } })
                return outcome
            },
        )

        controller.handle({
            t: "dispatch_run",
            runId: "run-1",
            goal: "first",
            workspaceId: "default",
            parallel: 1,
            timeoutSecs: 60,
            conversation: true,
        })
        assert.equal(executions, 1)
        assert.ok(sent.some((m) => m.t === "event" && m.runId === "run-1" && m.storyId === "S1"))

        controller.handle({
            t: "conversation_message",
            runId: "run-1",
            messageId: "m-1",
            text: "what is blocked?",
        })
        assert.deepEqual(JSON.parse(writes[0]!), {
            type: "dialogue_message",
            message_id: "m-1",
            text: "what is blocked?",
        })
        assert.ok(sent.some((m) => m.t === "command_ack" && m.commandId === "m-1" && m.status === "delivered"))

        // A replayed message gets the same terminal ACK without a second stdin write.
        controller.handle({
            t: "conversation_message",
            runId: "run-1",
            messageId: "m-1",
            text: "what is blocked?",
        })
        assert.equal(writes.length, 1)

        controller.handle({
            t: "agent_message",
            runId: "wrong-run",
            messageId: "agent-wrong",
            storyId: "S1",
            text: "wrong target",
        })
        controller.handle({
            t: "confirm_mode",
            runId: "wrong-run",
            commandId: "confirm-wrong",
            mode: "parallel",
        })
        controller.handle({
            t: "cancel",
            runId: "wrong-run",
            commandId: "cancel-wrong",
        })
        assert.equal(writes.length, 1)
        assert.equal(signals[0]!.aborted, false)
        for (const id of ["agent-wrong", "confirm-wrong", "cancel-wrong"]) {
            assert.ok(sent.some((m) => m.t === "command_ack" && m.commandId === id && m.status === "rejected"))
        }
        // A wrong-run rejection must not poison that id for the active run.
        controller.handle({
            t: "agent_message",
            runId: "run-1",
            messageId: "agent-wrong",
            storyId: "S1",
            text: "correct target",
        })
        assert.deepEqual(JSON.parse(writes[1]!), {
            type: "agent_message",
            id: "S1",
            text: "correct target",
        })
        assert.ok(sent.some((m) => m.t === "command_ack" && m.commandId === "agent-wrong" && m.runId === "run-1" && m.status === "delivered"))

        controller.handle({
            t: "dispatch_run",
            runId: "run-2",
            goal: "second",
            workspaceId: "default",
            parallel: 1,
            timeoutSecs: 60,
        })
        assert.equal(executions, 1)
        assert.ok(sent.some((m) => m.t === "run_result" && m.runId === "run-2" && m.success === false))
        assert.ok(sent.some((m) => m.t === "command_ack" && m.commandId === "run-2" && m.status === "rejected"))

        controller.handle({ t: "cancel", runId: "run-1", commandId: "cancel-1" })
        assert.equal(signals[0]!.aborted, true)
        assert.ok(sent.some((m) => m.t === "command_ack" && m.commandId === "cancel-1" && m.status === "delivered"))

        finish({ success: false, durationSecs: 2, error: "cancelled" })
        await tick()
        assert.ok(sent.some((m) => m.t === "run_result" && m.runId === "run-1" && m.error === "cancelled"))
        assert.equal(controller.activeCount, 0)

        // Control-plane reconnect/recovery can replay dispatch after the result
        // was produced. It receives the same result without executing twice.
        const beforeReplay = sent.length
        controller.handle({
            t: "dispatch_run",
            runId: "run-1",
            goal: "first",
            workspaceId: "default",
            parallel: 1,
            timeoutSecs: 60,
            conversation: true,
        })
        assert.equal(executions, 1)
        assert.ok(sent.slice(beforeReplay).some((m) => m.t === "run_result" && m.runId === "run-1" && m.error === "cancelled"))
        assert.ok(sent.slice(beforeReplay).some((m) => m.t === "command_ack" && m.commandId === "run-1" && m.status === "accepted"))

        sent.length = 0
        controller.replayTerminalResults()
        assert.ok(sent.some((m) => m.t === "run_result" && m.runId === "run-1" && m.error === "cancelled"))
        assert.ok(sent.some((m) => m.t === "run_result" && m.runId === "run-2" && m.success === false))
    })

    it("keeps v1 commands compatible when exactly one run is active", async () => {
        const writes: string[] = []
        let finish!: (outcome: { success: boolean; durationSecs: number; error: string | null }) => void
        const outcome = new Promise<{ success: boolean; durationSecs: number; error: string | null }>((resolve) => {
            finish = resolve
        })
        const controller = new RunnerProtocolController(
            () => {},
            async (dispatch, _emit, _signal, bindCommandSink) => {
                bindCommandSink(dispatch.runId, {
                    writable: true,
                    destroyed: false,
                    write(data: string, callback?: (error?: Error | null) => void) {
                        writes.push(data)
                        callback?.()
                        return true
                    },
                })
                return outcome
            },
        )
        controller.handle({ t: "dispatch_run", runId: "legacy", goal: "x", workspaceId: "default", parallel: 1, timeoutSecs: 60 })
        controller.handle({ t: "agent_message", storyId: "S2", text: "legacy nudge" })
        controller.handle({ t: "confirm_mode", mode: "focused" })
        assert.deepEqual(writes.map((line) => JSON.parse(line)), [
            { type: "agent_message", id: "S2", text: "legacy nudge" },
            { kind: "confirm_mode", mode: "focused" },
        ])
        finish({ success: true, durationSecs: 1, error: null })
        await tick()
    })

    it("delivers a correlated front-door clarification before init", async () => {
        const sent: Array<Record<string, unknown>> = []
        const writes: string[] = []
        let bind!: (runId: string, sink: { writable: boolean; destroyed: boolean; write(data: string, callback?: (error?: Error | null) => void): boolean } | null) => void
        let emitChild!: (event: { type: string; agentId: string; data: unknown }) => void
        let finish!: (outcome: { success: boolean; durationSecs: number; error: string | null }) => void
        const outcome = new Promise<{ success: boolean; durationSecs: number; error: string | null }>((resolve) => {
            finish = resolve
        })
        const controller = new RunnerProtocolController(
            (message) => sent.push(message as Record<string, unknown>),
            async (_dispatch, emit, _signal, bindCommandSink) => {
                bind = bindCommandSink
                emitChild = emit
                return outcome
            },
        )
        controller.handle({ t: "dispatch_run", runId: "early", goal: "x", workspaceId: "default", parallel: 1, timeoutSecs: 60, conversation: true })
        const sink = {
            writable: true,
            destroyed: false,
            write(data, callback) {
                writes.push(data)
                callback?.()
                return true
            },
        }
        bind("early", sink, false)
        emitChild({
            type: "conversation_response",
            agentId: "early",
            data: {
                type: "conversation_response",
                session_id: "session-1",
                request_id: "request-1",
                kind: "clarify",
                message: "I need one detail.",
                questions: [{ id: "q1", text: "Which API?" }],
            },
        })
        emitChild({
            type: "conversation_needs_input",
            agentId: "early",
            data: {
                type: "conversation_needs_input",
                session_id: "session-1",
                after_request_id: "request-1",
            },
        })
        controller.handle({
            t: "conversation_message",
            runId: "early",
            messageId: "early-1",
            sessionId: "session-1",
            afterRequestId: "wrong-request",
            text: "The public API.",
        })
        assert.equal(writes.length, 0, "a stale clarification target is rejected")
        controller.handle({
            t: "conversation_message",
            runId: "early",
            messageId: "early-2",
            sessionId: "session-1",
            afterRequestId: "request-1",
            text: "The public API.",
        })
        assert.deepEqual(JSON.parse(writes[0]!), {
            type: "conversation_message",
            session_id: "session-1",
            after_request_id: "request-1",
            message_id: "early-2",
            text: "The public API.",
        })
        assert.ok(sent.some((message) => message.t === "command_ack" && message.commandId === "early-1" && message.status === "rejected"))
        assert.ok(sent.some((message) => message.t === "command_ack" && message.commandId === "early-2" && message.status === "delivered"))

        // If both events were originally emitted while the socket was down,
        // reconnect replays them in order so Cloud can reconstruct the exact gate.
        sent.length = 0
        controller.replayConversationEvents()
        assert.deepEqual(
            sent.filter((message) => message.t === "event").map((message) => (message.event as { type: string }).type),
            ["conversation_response", "conversation_needs_input"],
        )
        assert.ok(sent.every((message) => message.runId === "early"))
        finish({ success: true, durationSecs: 1, error: null })
        await tick()
    })
})
