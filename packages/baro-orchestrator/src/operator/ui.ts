/* What the operator needs from a surface, and nothing about how it draws.
   Two adapters exist: the plain terminal chat (terminal-ui.ts) and the JSON
   line protocol the Rust TUI speaks (json-ui.ts). */

export interface RunRow {
    readonly id: string
    readonly state: "queued" | "running" | "completed" | "error" | "max-tokens" | "aborted"
    readonly phase: string
    readonly completed: number
    readonly total: number
    readonly goal: string
    readonly elapsed: string
    /** Epoch millis when the child started; absent while queued. */
    readonly startedMs: number | undefined
    readonly finishedMs: number | undefined
    readonly prUrl: string | undefined
    readonly activity: string | undefined
    readonly stories: readonly { id: string; title: string; status: string }[]
    /** Last milestones, oldest first. */
    readonly milestones: readonly string[]
    readonly error: string | undefined
}

export interface AskMeta {
    readonly kind: "permission" | "quit"
    readonly tool?: string
    readonly summary?: string
    readonly options: readonly string[]
}

export type UiCommand =
    | { readonly type: "user"; readonly text: string }
    | { readonly type: "runs" }
    | { readonly type: "status"; readonly id: string }
    | { readonly type: "stop"; readonly id: string }
    | { readonly type: "quit"; readonly stopRuns?: boolean }

export interface TurnResult {
    readonly durationMs: number | null
    readonly totalCostUsd: number | null
}

export interface OperatorUi {
    /** A slice of the assistant's reply, in order. */
    stream(text: string): void
    /** One dim line: a milestone, a queue note, a refusal. */
    note(text: string): void
    toolCall(name: string, summary: string): void
    /** What the last tool returned, reduced to one line. */
    toolResult(summary: string): void
    /** Resolves with the person's answer; the operator asks one thing at a time. */
    ask(prompt: string, meta: AskMeta): Promise<string>
    turnDone(result: TurnResult): void
    runsChanged(rows: readonly RunRow[]): void
    banner(text: string): void
    onCommand(handler: (command: UiCommand) => void): void
    close(): void
}
