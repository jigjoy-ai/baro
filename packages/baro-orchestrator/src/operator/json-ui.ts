import { createInterface } from "node:readline"

import type { AskMeta, OperatorUi, RunRow, TurnResult, UiCommand } from "./ui.js"

/* The wire the Rust TUI speaks: one JSON object per line on stdout, one per
   line on stdin. Events out: ready, assistant_delta, tool_call, note,
   ask (id, kind, prompt, tool, summary, options), turn_done, runs, exit.
   Commands in: user {text}, answer {id, answer}, runs, status {id},
   stop {id}, quit {stop_runs}. Documented in docs/operator-protocol.md. */
export class JsonUi implements OperatorUi {
    private handler: ((command: UiCommand) => void) | null = null
    private readonly pendingAsks = new Map<string, (answer: string) => void>()
    private askSequence = 0

    constructor() {
        createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
            .on("line", (line) => this.onLine(line))
            .on("close", () => this.handler?.({ type: "quit", stopRuns: false }))
    }

    onCommand(handler: (command: UiCommand) => void): void {
        this.handler = handler
        this.emit({ type: "ready" })
    }

    banner(text: string): void {
        this.emit({ type: "note", text })
    }

    stream(text: string): void {
        this.emit({ type: "assistant_delta", text })
    }

    note(text: string): void {
        this.emit({ type: "note", text: text.trim() })
    }

    toolCall(name: string, summary: string): void {
        this.emit({ type: "tool_call", name, summary })
    }

    toolResult(summary: string): void {
        this.emit({ type: "tool_result", summary })
    }

    ask(prompt: string, meta: AskMeta): Promise<string> {
        this.askSequence += 1
        const id = `ask-${this.askSequence}`
        return new Promise((resolve) => {
            this.pendingAsks.set(id, resolve)
            this.emit({
                type: "ask",
                id,
                kind: meta.kind,
                prompt,
                ...(meta.tool ? { tool: meta.tool } : {}),
                ...(meta.summary ? { summary: meta.summary } : {}),
                options: meta.options,
            })
        })
    }

    turnDone(result: TurnResult): void {
        this.emit({ type: "turn_done", duration_ms: result.durationMs, cost_usd: result.totalCostUsd })
    }

    runsChanged(rows: readonly RunRow[]): void {
        this.emit({
            type: "runs",
            runs: rows.map((row) => ({
                id: row.id,
                state: row.state,
                phase: row.phase,
                completed: row.completed,
                total: row.total,
                goal: row.goal,
                elapsed: row.elapsed,
                ...(row.startedMs !== undefined ? { started_ms: row.startedMs } : {}),
                ...(row.finishedMs !== undefined ? { finished_ms: row.finishedMs } : {}),
                ...(row.prUrl ? { pr_url: row.prUrl } : {}),
            })),
        })
    }

    close(): void {
        this.emit({ type: "exit" })
    }

    private onLine(line: string): void {
        let command: Record<string, unknown>
        try {
            command = JSON.parse(line) as Record<string, unknown>
        } catch {
            return
        }
        switch (command.type) {
            case "user":
                if (typeof command.text === "string" && command.text.trim()) {
                    this.handler?.({ type: "user", text: command.text.trim() })
                }
                return
            case "answer": {
                const resolve = this.pendingAsks.get(String(command.id))
                if (resolve) {
                    this.pendingAsks.delete(String(command.id))
                    resolve(String(command.answer ?? "").trim())
                }
                return
            }
            case "runs":
                this.handler?.({ type: "runs" })
                return
            case "status":
                this.handler?.({ type: "status", id: String(command.id ?? "") })
                return
            case "stop":
                this.handler?.({ type: "stop", id: String(command.id ?? "") })
                return
            case "quit":
                this.handler?.({ type: "quit", stopRuns: command.stop_runs === true })
                return
            default:
                return
        }
    }

    private emit(event: Record<string, unknown>): void {
        process.stdout.write(JSON.stringify({ ...event, ts: new Date().toISOString() }) + "\n")
    }
}
