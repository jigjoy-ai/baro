import { createInterface, clearLine, cursorTo } from "node:readline"

import type { AskMeta, OperatorUi, RunRow, TurnResult, UiCommand } from "./ui.js"

const DIM = "[2m"
const RESET = "[0m"
const AMBER = "[33m"

/* The bare chat: white for the model, dim for everything else, questions
   inline. Nothing prints over an open question; notes wait for the answer. */
export class TerminalUi implements OperatorUi {
    private readonly out = process.stdout
    private readonly rl = createInterface({ input: process.stdin, output: this.out, prompt: "you › " })
    private handler: ((command: UiCommand) => void) | null = null
    private busy = false
    private asking = false
    private lineOpen = false
    private readonly heldNotes: string[] = []
    private askChain: Promise<unknown> = Promise.resolve()

    constructor() {
        this.rl.on("line", (line) => this.onLine(line))
        this.rl.on("close", () => this.handler?.({ type: "quit" }))
        this.rl.on("SIGINT", () => this.handler?.({ type: "quit" }))
    }

    onCommand(handler: (command: UiCommand) => void): void {
        this.handler = handler
        this.rl.prompt()
    }

    banner(text: string): void {
        this.out.write(`${DIM}${text}${RESET}\n`)
    }

    stream(text: string): void {
        if (!this.lineOpen) this.clearPrompt()
        this.out.write(text)
        this.lineOpen = !text.endsWith("\n")
    }

    note(text: string): void {
        if (this.asking) {
            this.heldNotes.push(text)
            return
        }
        this.clearPrompt()
        this.endLine()
        this.out.write(`${DIM}${text}${RESET}\n`)
        this.reprompt()
    }

    toolCall(name: string, summary: string): void {
        this.note(`  ⚙ ${name} ${summary}`)
    }

    toolResult(summary: string): void {
        this.note(`    ⎿ ${summary}`)
    }

    ask(prompt: string, meta: AskMeta): Promise<string> {
        const question =
            meta.kind === "permission"
                ? `${AMBER}⚠ ${meta.tool ?? "tool"}${RESET} ${meta.summary ?? ""}\n  ${prompt} [${meta.options.join("/")}] `
                : `${prompt} [${meta.options.join("/")}] `
        const turn = this.askChain.then(
            () =>
                new Promise<string>((resolve) => {
                    this.asking = true
                    this.endLine()
                    this.rl.question(question, (answer) => {
                        this.asking = false
                        resolve(answer.trim())
                        for (const held of this.heldNotes.splice(0)) this.note(held)
                    })
                }),
        )
        this.askChain = turn.catch(() => undefined)
        return turn
    }

    turnDone(result: TurnResult): void {
        this.endLine()
        const facts = [
            result.durationMs !== null ? `${(result.durationMs / 1000).toFixed(0)}s` : undefined,
            result.totalCostUsd !== null ? `$${result.totalCostUsd.toFixed(2)}` : undefined,
        ].filter(Boolean)
        if (facts.length) this.out.write(`${DIM}· ${facts.join(" · ")}${RESET}\n`)
        this.busy = false
        this.reprompt()
    }

    runsChanged(_rows: readonly RunRow[]): void {
        // The terminal reads runs on demand (/runs); milestones arrive as notes.
    }

    close(): void {
        this.rl.close()
    }

    private onLine(line: string): void {
        const text = line.trim()
        if (!text) {
            this.reprompt()
            return
        }
        if (text === "/quit" || text === "/exit") return this.handler?.({ type: "quit" })
        if (text === "/runs") return this.handler?.({ type: "runs" })
        if (text.startsWith("/status")) return this.handler?.({ type: "status", id: text.split(/\s+/)[1] ?? "" })
        if (text.startsWith("/stop")) return this.handler?.({ type: "stop", id: text.split(/\s+/)[1] ?? "" })
        this.busy = true
        this.handler?.({ type: "user", text })
    }

    private clearPrompt(): void {
        if (this.asking) return
        clearLine(this.out, 0)
        cursorTo(this.out, 0)
    }

    private endLine(): void {
        if (this.lineOpen) {
            this.out.write("\n")
            this.lineOpen = false
        }
    }

    private reprompt(): void {
        if (!this.busy && !this.asking) this.rl.prompt(true)
    }
}
