import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"

import { parseLine } from "./protocol.js"
import {
    RunTracker,
    renderOutcome,
    renderProgress,
    resolveTerminal,
    type RunSummary,
    type Terminal,
} from "./run-tracker.js"

/* The operator's back office: every delegated goal is one headless baro
   child, watched through its protocol stream. Runs outlive turns of the
   conversation; the registry is what "what are they doing" reads. */

export interface RunRecord {
    readonly id: string
    readonly goal: string
    readonly cwd: string
    readonly startedAt: number
    finishedAt: number | null
    terminal: Terminal | null
    exitCode: number | null
    readonly tracker: RunTracker
    readonly stderrTail: string[]
}

export interface RunRegistryOptions {
    /** Extra args every child gets (`--local-only`, `--llm …`). */
    readonly baroArgs?: readonly string[]
    readonly baroBin?: string
    onMilestone?(run: RunRecord, line: string): void
    onFinished?(run: RunRecord, outcome: string): void
}

const STDERR_TAIL = 20

export class RunRegistry {
    private readonly runs = new Map<string, RunRecord>()
    private readonly children = new Map<string, ChildProcess>()
    private sequence = 0

    constructor(private readonly options: RunRegistryOptions = {}) {}

    delegate(goal: string, cwd: string): RunRecord {
        this.sequence += 1
        const id = `run-${this.sequence}`
        const record: RunRecord = {
            id,
            goal,
            cwd,
            startedAt: Date.now(),
            finishedAt: null,
            terminal: null,
            exitCode: null,
            tracker: new RunTracker(),
            stderrTail: [],
        }
        this.runs.set(id, record)

        const env = { ...process.env }
        // A child that inherits the parent's run id believes it is that run.
        delete env.BARO_RUN_ID
        const child = spawn(
            resolveBaroBin(this.options.baroBin),
            [goal, "--headless", "--cwd", cwd, ...(this.options.baroArgs ?? [])],
            {
                cwd,
                env,
                // Closed, not merely silent: headless baro answers its own
                // intake questions only once stdin reaches EOF.
                stdio: ["ignore", "pipe", "pipe"],
                detached: true,
            },
        )
        this.children.set(id, child)

        createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY }).on(
            "line",
            (line) => {
                const event = parseLine(line)
                if (!event) return
                const milestone = record.tracker.accept(event)
                if (milestone) this.options.onMilestone?.(record, milestone)
            },
        )
        createInterface({ input: child.stderr!, crlfDelay: Number.POSITIVE_INFINITY }).on(
            "line",
            (line) => {
                record.stderrTail.push(line)
                if (record.stderrTail.length > STDERR_TAIL) record.stderrTail.shift()
            },
        )
        child.once("exit", (code) => {
            record.exitCode = code
            record.finishedAt = Date.now()
            const summary = record.tracker.summary()
            record.terminal = resolveTerminal(
                record.terminal === "aborted",
                code,
                summary.done,
            )
            this.children.delete(id)
            this.options.onFinished?.(record, renderOutcome(summary, record.terminal))
        })
        child.once("error", (error) => {
            record.stderrTail.push(`spawn failed: ${error.message}`)
        })
        return record
    }

    stop(id: string): boolean {
        const record = this.runs.get(id)
        const child = this.children.get(id)
        if (!record || !child || child.pid === undefined) return false
        record.terminal = "aborted"
        try {
            process.kill(-child.pid, "SIGTERM")
        } catch {
            child.kill("SIGTERM")
        }
        return true
    }

    get(id: string): RunRecord | undefined {
        return this.runs.get(id)
    }

    list(): RunRecord[] {
        return [...this.runs.values()]
    }

    running(): RunRecord[] {
        return this.list().filter((run) => run.finishedAt === null)
    }

    /** One line per run, for the terminal strip and the `runs` tool. */
    table(): string {
        if (this.runs.size === 0) return "no runs yet"
        return this.list()
            .map((run) => {
                const s = run.tracker.summary()
                const state = run.terminal ?? "running"
                const progress =
                    s.total > 0 ? ` ${s.completed}/${s.total}` : s.storiesTotal ? ` ${s.storiesTotal} stories` : ""
                return `${run.id} [${state}] ${s.phase}${progress} · ${elapsed(run)} · ${run.goal.slice(0, 70)}`
            })
            .join("\n")
    }

    status(id: string): string {
        const run = this.runs.get(id)
        if (!run) return `unknown run: ${id}`
        const summary: RunSummary = run.tracker.summary()
        const head = `${run.id} [${run.terminal ?? "running"}] · ${elapsed(run)}\ngoal: ${run.goal}\ncwd: ${run.cwd}`
        const body = run.terminal
            ? renderOutcome(summary, run.terminal)
            : renderProgress(summary)
        const stderr =
            run.terminal && run.terminal !== "completed" && run.stderrTail.length
                ? `\n\nstderr tail:\n${run.stderrTail.join("\n")}`
                : ""
        return `${head}\n\n${body}${stderr}`
    }
}

function resolveBaroBin(explicit: string | undefined): string {
    if (explicit) return explicit
    if (process.env.BARO_BIN) return process.env.BARO_BIN
    // Staged next to the bundles in ~/.baro/bin; dev checkouts fall back to PATH.
    const entry = process.argv[1]
    if (entry) {
        const sibling = join(dirname(entry), "baro")
        if (existsSync(sibling)) return sibling
    }
    return "baro"
}

function elapsed(run: RunRecord): string {
    const ms = (run.finishedAt ?? Date.now()) - run.startedAt
    const s = Math.floor(ms / 1000)
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}
