#!/usr/bin/env tsx
/**
 * Spike: Claude Code CLI as a Mozaik Participant — proves bidirectional
 * stream-json works inside an AgenticEnvironment and captures a real event
 * log to design the Phase 1 stream-json mapper against.
 *
 * Modes:
 *   (default)        single Claude participant + logger, one user message
 *   --two-stories    two parallel Claude participants in same env
 *   --midflight      inject a second user message via the bus mid-turn
 */

import { ChildProcess, spawn } from "child_process"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import {
    AgenticEnvironment,
    ContextItem,
    Participant,
    UserMessageItem,
} from "@mozaik-ai/core"

// Claude events are carried raw (mapping to Mozaik typed items is Phase 1)
// so the logger records the actual event shapes we'll be mapping against.
class RawClaudeEventItem extends ContextItem {
    readonly type = "raw_claude_event"

    constructor(
        public readonly agentId: string,
        public readonly raw: any,
    ) {
        super()
    }

    toJSON(): any {
        return {
            type: this.type,
            agentId: this.agentId,
            raw: this.raw,
        }
    }
}

// Phase 1 will need a way to address messages to a specific agent; the spike
// cheats with a subclass carrying recipientId.
class TargetedUserMessageItem extends ContextItem {
    readonly type = "targeted_user_message"

    constructor(
        public readonly recipientId: string,
        public readonly text: string,
    ) {
        super()
    }

    toJSON(): any {
        return {
            type: this.type,
            recipientId: this.recipientId,
            text: this.text,
        }
    }
}

class SpikeClaudeParticipant extends Participant {
    private proc: ChildProcess | null = null
    private buffer = ""
    private envRef: AgenticEnvironment | null = null
    private resolveDone!: () => void

    public lastResult: any = null
    public readonly donePromise: Promise<void>

    constructor(
        public readonly agentId: string,
        public readonly cwd: string,
        public readonly model?: string,
    ) {
        super()
        this.donePromise = new Promise<void>((r) => {
            this.resolveDone = r
        })
    }

    start(env: AgenticEnvironment): void {
        this.envRef = env

        const args = [
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--replay-user-messages",
            "--permission-mode",
            "bypassPermissions",
        ]
        if (this.model) {
            args.push("--model", this.model)
        }

        const proc = spawn("claude", args, {
            cwd: this.cwd,
            stdio: ["pipe", "pipe", "pipe"],
        })
        this.proc = proc

        proc.stdout!.setEncoding("utf8")
        proc.stderr!.setEncoding("utf8")

        proc.stdout!.on("data", (chunk: string) => this.handleStdout(chunk))
        proc.stderr!.on("data", (chunk: string) => {
            const trimmed = chunk.trimEnd()
            if (trimmed) {
                process.stderr.write(`[${this.agentId}/stderr] ${trimmed}\n`)
            }
        })
        proc.on("exit", (code) => {
            process.stderr.write(`[${this.agentId}] exited code=${code}\n`)
            this.resolveDone()
        })
    }

    private handleStdout(chunk: string): void {
        this.buffer += chunk
        let idx: number
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, idx).trim()
            this.buffer = this.buffer.slice(idx + 1)
            if (!line) continue

            let parsed: any
            try {
                parsed = JSON.parse(line)
            } catch {
                process.stderr.write(
                    `[${this.agentId}] non-JSON stdout line: ${line.slice(0, 200)}\n`,
                )
                continue
            }

            const item = new RawClaudeEventItem(this.agentId, parsed)
            this.envRef?.deliverContextItem(this, item)

            if (parsed?.type === "result") {
                this.lastResult = parsed
            }
        }
    }

    sendUserMessage(text: string): void {
        if (!this.proc?.stdin) {
            throw new Error(`[${this.agentId}] proc not started`)
        }
        const event = {
            type: "user",
            message: { role: "user", content: text },
        }
        this.proc.stdin.write(JSON.stringify(event) + "\n")
    }

    closeStdin(): void {
        this.proc?.stdin?.end()
    }

    async onContextItem(source: Participant, item: ContextItem): Promise<void> {
        if (source === this) return

        // Bus → Claude path: targeted user messages are forwarded into the
        // Claude process via stdin. Plain UserMessageItem (no recipient) is
        // ignored to avoid every Claude in a multi-agent env hearing it.
        if (item instanceof TargetedUserMessageItem && item.recipientId === this.agentId) {
            process.stderr.write(
                `[${this.agentId}] receiving bus message → forwarding to Claude stdin\n`,
            )
            this.sendUserMessage(item.text)
        }
    }

    stop(): void {
        this.proc?.kill()
    }
}

class TranscriptLogger extends Participant {
    constructor(
        private readonly logPath: string,
        private readonly mirrorToConsole = true,
    ) {
        super()
    }

    async onContextItem(source: Participant, item: ContextItem): Promise<void> {
        const sourceName =
            source instanceof SpikeClaudeParticipant
                ? `claude:${source.agentId}`
                : source.constructor.name

        const json = item.toJSON()
        appendFileSync(
            this.logPath,
            JSON.stringify({
                ts: new Date().toISOString(),
                source: sourceName,
                item: json,
            }) + "\n",
        )

        if (this.mirrorToConsole) {
            const claudeType = json?.raw?.type
            const claudeSubtype = json?.raw?.subtype
            const summary = claudeType
                ? `${claudeType}${claudeSubtype ? `:${claudeSubtype}` : ""}`
                : json.type
            process.stdout.write(`[${sourceName}] ${summary}\n`)
        }
    }
}

// Passive participant that exists only to be a valid `source` for initial
// bus deliveries (Mozaik's deliverContextItem requires one).
class SpikeOriginator extends Participant {
    async onContextItem(): Promise<void> {
        return
    }
}

function setupTestRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "baro-spike-"))
    writeFileSync(
        join(dir, "README.md"),
        "# Spike Test Repo\n\nA tiny repo for the Mozaik spike.\n",
    )
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "spike", version: "0.0.0" }, null, 2),
    )
    writeFileSync(join(dir, "index.ts"), "export const hello = 'world'\n")
    writeFileSync(join(dir, "utils.ts"), "export const add = (a: number, b: number) => a + b\n")
    return dir
}

async function runSingle(logPath: string): Promise<void> {
    const env = new AgenticEnvironment()
    const cwd = setupTestRepo()
    process.stderr.write(`[spike] test repo: ${cwd}\n`)

    const claude = new SpikeClaudeParticipant("S1", cwd)
    const logger = new TranscriptLogger(logPath)
    const originator = new SpikeOriginator()

    claude.join(env)
    logger.join(env)
    originator.join(env)

    claude.start(env)

    // Path being tested: bus → Claude.
    env.deliverContextItem(
        originator,
        new TargetedUserMessageItem(
            "S1",
            "List the files in the current directory using the Bash tool (`ls -1`) and tell me how many there are.",
        ),
    )
    claude.closeStdin()

    await raceWithTimeout(claude.donePromise, 120_000, "single mode timeout")
    process.stderr.write(`[spike] done. log: ${logPath}\n`)
}

async function runTwo(logPath: string): Promise<void> {
    const env = new AgenticEnvironment()
    const cwd = setupTestRepo()
    process.stderr.write(`[spike] test repo: ${cwd}\n`)

    const a = new SpikeClaudeParticipant("S1", cwd)
    const b = new SpikeClaudeParticipant("S2", cwd)
    const logger = new TranscriptLogger(logPath)
    const originator = new SpikeOriginator()

    a.join(env)
    b.join(env)
    logger.join(env)
    originator.join(env)

    a.start(env)
    b.start(env)

    env.deliverContextItem(
        originator,
        new TargetedUserMessageItem(
            "S1",
            "Read README.md and tell me its first line.",
        ),
    )
    env.deliverContextItem(
        originator,
        new TargetedUserMessageItem(
            "S2",
            "Read package.json and tell me the value of the name field.",
        ),
    )
    a.closeStdin()
    b.closeStdin()

    await raceWithTimeout(
        Promise.all([a.donePromise, b.donePromise]).then(() => undefined),
        180_000,
        "two-stories mode timeout",
    )
    process.stderr.write(`[spike] done. log: ${logPath}\n`)
}

async function runMidflight(logPath: string): Promise<void> {
    const env = new AgenticEnvironment()
    const cwd = setupTestRepo()
    process.stderr.write(`[spike] test repo: ${cwd}\n`)

    const claude = new SpikeClaudeParticipant("S1", cwd)
    const logger = new TranscriptLogger(logPath)
    const originator = new SpikeOriginator()

    claude.join(env)
    logger.join(env)
    originator.join(env)

    claude.start(env)

    // First task: take a few seconds (force at least one tool call).
    env.deliverContextItem(
        originator,
        new TargetedUserMessageItem(
            "S1",
            "Use the Bash tool to run `sleep 4` then list files with `ls -1`.",
        ),
    )

    // After 1s, inject a second message via the bus while Claude is still
    // executing the first. Phase-1 critical question: does Claude queue this
    // for the next turn, or accept it mid-flight?
    setTimeout(() => {
        process.stderr.write(`[spike] injecting mid-flight message\n`)
        env.deliverContextItem(
            originator,
            new TargetedUserMessageItem(
                "S1",
                "[INJECTED] Also tell me how many files there are in total.",
            ),
        )
        claude.closeStdin()
    }, 1000)

    await raceWithTimeout(claude.donePromise, 180_000, "midflight mode timeout")
    process.stderr.write(`[spike] done. log: ${logPath}\n`)
}

function raceWithTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
    ])
}

async function main(): Promise<void> {
    const args = process.argv.slice(2)
    const mode = args.includes("--two-stories")
        ? "two"
        : args.includes("--midflight")
          ? "midflight"
          : "single"

    const logsDir = join(import.meta.dirname, "spike-logs")
    mkdirSync(logsDir, { recursive: true })
    const logPath = join(logsDir, `spike-${mode}-${Date.now()}.jsonl`)

    process.stderr.write(`[spike] mode=${mode} log=${logPath}\n`)

    if (mode === "single") await runSingle(logPath)
    else if (mode === "two") await runTwo(logPath)
    else await runMidflight(logPath)
}

main().catch((e) => {
    process.stderr.write(`[spike] fatal: ${e?.stack ?? e}\n`)
    process.exit(1)
})
