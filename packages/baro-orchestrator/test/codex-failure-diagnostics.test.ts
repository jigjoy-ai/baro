import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { CodexFailureDiagnostics } from "../src/codex-failure-diagnostics.js"

describe("CodexFailureDiagnostics", () => {
    it("logs current and legacy failures without retaining MCP payloads or secrets", () => {
        const previous = process.env.OPENAI_API_KEY
        process.env.OPENAI_API_KEY = "environment-secret-value"
        const lines: string[] = []
        try {
            const diagnostics = new CodexFailureDiagnostics(
                "codex-architect",
                (line) => lines.push(line),
                {
                    BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN:
                        "additional-environment-secret",
                    DISPLAY_HINT: "arbitrary-name-secret-value",
                },
            )
            diagnostics.observe({
                type: "item.started",
                item: {
                    id: "call-1",
                    type: "mcp_tool_call",
                    server: "codex_apps",
                    tool: "github.search",
                    status: "in_progress",
                    arguments: {
                        query: "private source text",
                        api_key: "environment-secret-value",
                    },
                },
            })
            diagnostics.observe({
                type: "item.completed",
                item: {
                    id: "call-1",
                    type: "mcp_tool_call",
                    server: "codex_apps",
                    tool: "github.search",
                    status: "failed",
                    arguments: { query: "private source text" },
                    result: "raw result must never be logged",
                    error: {
                        message:
                            "Authorization: Basic dXNlcjpwYXNzd29yZA== Bearer abcdefghijklmnop environment-secret-value additional-environment-secret arbitrary-name-secret-value\nconnector failed",
                    },
                },
            })
            diagnostics.observe({
                type: "item.completed",
                item: {
                    type: "error",
                    message: "tool item failed\r\nwith details",
                },
            })
            diagnostics.observe({
                type: "error",
                message: "top-level failure",
            })
            diagnostics.observe({
                type: "turn.failed",
                error: { message: "current nested turn failure" },
            })
            diagnostics.observe({
                type: "turn.failed",
                error: "legacy string turn failure",
            })

            const summary = diagnostics.abnormalSummary()
            const output = lines.join("") + summary

            assert.match(output, /server="codex_apps"/)
            assert.match(output, /tool="github\.search"/)
            assert.match(output, /status="failed"/)
            assert.match(output, /current nested turn failure/)
            assert.match(output, /legacy string turn failure/)
            assert.match(output, /tool item failed with details/)
            assert.doesNotMatch(output, /private source text/)
            assert.doesNotMatch(output, /raw result must never be logged/)
            assert.doesNotMatch(output, /environment-secret-value/)
            assert.doesNotMatch(output, /additional-environment-secret/)
            assert.doesNotMatch(output, /arbitrary-name-secret-value/)
            assert.doesNotMatch(output, /abcdefghijklmnop/)
            assert.doesNotMatch(output, /dXNlcjpwYXNzd29yZA/)
            assert.match(output, /\[REDACTED:OPENAI_API_KEY\]/)
            assert.match(
                output,
                /\[REDACTED:BARO_PROGRESSIVE_PLANNER_RELAY_TOKEN\]/,
            )
            assert.match(output, /\[REDACTED:DISPLAY_HINT\]/)
            assert.match(output, /Authorization: \[REDACTED\]/)
            assert.match(output, /Bearer \[REDACTED\]/)
            for (const line of lines) {
                assert.equal(line.endsWith("\n"), true)
                assert.equal(line.slice(0, -1).includes("\n"), false)
                assert.equal(line.includes("\u001B"), false)
            }
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY
            else process.env.OPENAI_API_KEY = previous
        }
    })

    it("bounds individual messages, retained context, and failure count", () => {
        const lines: string[] = []
        const diagnostics = new CodexFailureDiagnostics(
            "codex",
            (line) => lines.push(line),
        )

        for (let index = 0; index < 20; index += 1) {
            diagnostics.observe({
                type: "error",
                message: `${index}:${"diagnostic ".repeat(2_000)}`,
            })
        }
        const summary = diagnostics.abnormalSummary()

        assert.equal(lines.length, 9)
        assert.match(lines.at(-1)!, /failure_diagnostic omitted=additional/)
        assert.ok(
            lines.every(
                (line) => Buffer.byteLength(line, "utf8") < 3 * 1024,
            ),
        )
        assert.ok(Buffer.byteLength(summary, "utf8") <= 8 * 1024)
        assert.match(summary, /…\[truncated\]/)
    })

    it("redacts overlapping explicit secrets longest-first", () => {
        const lines: string[] = []
        const diagnostics = new CodexFailureDiagnostics(
            "codex",
            (line) => lines.push(line),
            {
                A_TOKEN: "abcd",
                B_TOKEN: "abcdefgh",
            },
        )

        diagnostics.observe({
            type: "turn.failed",
            error: {
                message: "overlap=abcdefgh ansi=abcd\u001b[31mefgh",
            },
        })

        const output = lines.join("")
        assert.match(output, /overlap=\[REDACTED:B_TOKEN\]/)
        assert.match(output, /ansi=\[REDACTED:B_TOKEN\]/)
        assert.doesNotMatch(output, /abcdefgh|\[REDACTED:A_TOKEN\]efgh/)
    })

    it("always retains the terminal turn failure after earlier error noise", () => {
        const lines: string[] = []
        const diagnostics = new CodexFailureDiagnostics(
            "codex",
            (line) => lines.push(line),
        )
        for (let index = 0; index < 12; index += 1) {
            diagnostics.observe({ type: "error", message: `noise-${index}` })
        }
        for (let index = 0; index < 8; index += 1) {
            const escaped = `${index}${'"\\'.repeat(120)}`
            diagnostics.observe({
                type: "item.started",
                item: {
                    id: escaped,
                    type: "mcp_tool_call",
                    server: escaped,
                    tool: escaped,
                    status: "in_progress",
                },
            })
        }
        diagnostics.observe({
            type: "turn.failed",
            error: {
                message: `THE TERMINAL CAUSE ${"x".repeat(2_000)}`,
            },
        })

        const summary = diagnostics.abnormalSummary()

        assert.match(lines.join(""), /THE TERMINAL CAUSE/)
        assert.match(summary, /THE TERMINAL CAUSE/)
        assert.ok(Buffer.byteLength(summary, "utf8") <= 8 * 1024)
    })

    it("reports only MCP calls that remain in flight at abnormal exit", () => {
        const lines: string[] = []
        const diagnostics = new CodexFailureDiagnostics(
            "codex",
            (line) => lines.push(line),
        )
        diagnostics.observe({
            type: "item.started",
            item: {
                id: "finished-call",
                type: "mcp_tool_call",
                server: "repo",
                tool: "read_file",
                status: "in_progress",
            },
        })
        diagnostics.observe({
            type: "item.started",
            item: {
                id: "unfinished-call",
                type: "mcp_tool_call",
                server: "repo",
                tool: "grep",
                status: "in_progress",
            },
        })
        diagnostics.observe({
            type: "item.completed",
            item: {
                id: "finished-call",
                type: "mcp_tool_call",
                server: "repo",
                tool: "read_file",
                status: "completed",
            },
        })

        const summary = diagnostics.abnormalSummary()
        const unfinished = lines.filter((line) =>
            line.includes("mcp_tool_call.unfinished"),
        )

        assert.equal(unfinished.length, 1)
        assert.match(unfinished[0]!, /id="unfinished-call"/)
        assert.doesNotMatch(unfinished[0]!, /id="finished-call"/)
        assert.match(summary, /id="unfinished-call"/)
    })
})
