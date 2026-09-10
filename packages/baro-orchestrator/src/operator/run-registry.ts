import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"

import { parseLine } from "./protocol.js"
import type { RunRow } from "./ui.js"
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
   conversation; the registry is what "what are they doing" reads.

   baro holds one session lock per repository, so a second goal for the same
   cwd is queued here and started when the first one exits — run-2 of the
   first live session died in 0s on that lock. Disjoint-write concurrency
   within one repository is baro's to grant, not this registry's to assume. */

export type RunState = "queued" | "running" | "finished"

export interface RunRecord {
    readonly id: string
    readonly goal: string
    readonly cwd: string
    readonly queuedAt: number
    startedAt: number | null
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
    onStarted?(run: RunRecord, behind: RunRecord | null): void
    onMilestone?(run: RunRecord, line: string): void
    onFinished?(run: RunRecord, outcome: string): void
}

const STDERR_TAIL = 20

export class RunRegistry {
    private readonly runs = new Map<string, RunRecord>()
    private readonly children = new Map<string, ChildProcess>()
    private readonly active = new Map<string, string>()
    private readonly queues = new Map<string, RunRecord[]>()
    private sequence = 0

    constructor(private readonly options: RunRegistryOptions = {}) {}

    /** Starts the run, or queues it behind the run holding this repository. */
    delegate(goal: string, cwd: string): { run: RunRecord; behind: RunRecord | null } {
        this.sequence += 1
        const record: RunRecord = {
            id: `run-${this.sequence}`,
            goal,
            cwd,
            queuedAt: Date.now(),
            startedAt: null,
            finishedAt: null,
            terminal: null,
            exitCode: null,
            tracker: new RunTracker(),
            stderrTail: [],
        }
        this.runs.set(record.id, record)
        const holder = this.active.get(cwd)
        const behind = holder ? (this.runs.get(holder) ?? null) : null
        if (behind) {
            const queue = this.queues.get(cwd) ?? []
            queue.push(record)
            this.queues.set(cwd, queue)
            return { run: record, behind }
        }
        this.start(record)
        return { run: record, behind: null }
    }

    stop(id: string): boolean {
        const record = this.runs.get(id)
        if (!record || record.finishedAt !== null) return false
        if (record.startedAt === null) {
            const queue = this.queues.get(record.cwd) ?? []
            this.queues.set(
                record.cwd,
                queue.filter((queued) => queued.id !== id),
            )
            record.terminal = "aborted"
            record.finishedAt = Date.now()
            return true
        }
        const child = this.children.get(id)
        if (!child || child.pid === undefined) return false
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

    stateOf(run: RunRecord): RunState {
        if (run.finishedAt !== null) return "finished"
        return run.startedAt === null ? "queued" : "running"
    }

    /** Structured rows for a surface that draws its own strip. */
    rows(): RunRow[] {
        return this.list().map((run) => {
            const s = run.tracker.summary()
            return {
                id: run.id,
                state: run.terminal ?? (run.startedAt === null ? "queued" : "running"),
                phase: run.startedAt === null ? "queued" : s.phase,
                completed: s.completed,
                total: s.total > 0 ? s.total : s.storiesTotal,
                goal: run.goal,
                elapsed: elapsed(run),
                startedMs: run.startedAt ?? undefined,
                finishedMs: run.finishedAt ?? undefined,
                prUrl: s.prUrl,
            }
        })
    }

    /** One line per run, for the terminal strip and the `runs` tool. */
    table(): string {
        if (this.runs.size === 0) return "no runs yet"
        return this.list()
            .map((run) => {
                const s = run.tracker.summary()
                const state = run.terminal ?? this.stateOf(run)
                const progress =
                    s.total > 0 ? ` ${s.completed}/${s.total}` : s.storiesTotal ? ` ${s.storiesTotal} stories` : ""
                const phase = run.startedAt === null ? `queued behind ${this.active.get(run.cwd) ?? "?"}` : s.phase
                return `${run.id} [${state}] ${phase}${progress} · ${elapsed(run)} · ${run.goal.slice(0, 70)}`
            })
            .join("\n")
    }

    status(id: string): string {
        const run = this.runs.get(id)
        if (!run) return `unknown run: ${id}`
        const summary: RunSummary = run.tracker.summary()
        const state = run.terminal ?? this.stateOf(run)
        const head = `${run.id} [${state}] · ${elapsed(run)}\ngoal: ${run.goal}\ncwd: ${run.cwd}`
        if (run.startedAt === null && run.finishedAt === null) {
            return `${head}\n\nqueued: baro allows one run per repository; starts automatically when ${this.active.get(run.cwd) ?? "the current run"} exits.`
        }
        const body = run.terminal ? renderOutcome(summary, run.terminal) : renderProgress(summary)
        const stderr =
            run.terminal && run.terminal !== "completed" && run.stderrTail.length
                ? `\n\nstderr tail:\n${run.stderrTail.join("\n")}`
                : ""
        return `${head}\n\n${body}${stderr}`
    }

    private start(record: RunRecord): void {
        record.startedAt = Date.now()
        this.active.set(record.cwd, record.id)

        const env = { ...process.env }
        // A child that inherits the parent's run id believes it is that run.
        delete env.BARO_RUN_ID
        const child = spawn(
            resolveBaroBin(this.options.baroBin),
            [record.goal, "--headless", "--cwd", record.cwd, ...(this.options.baroArgs ?? [])],
            {
                cwd: record.cwd,
                env,
                // Closed, not merely silent: headless baro answers its own
                // intake questions only once stdin reaches EOF.
                stdio: ["ignore", "pipe", "pipe"],
                detached: true,
            },
        )
        this.children.set(record.id, child)

        createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
            const event = parseLine(line)
            if (!event) return
            const milestone = record.tracker.accept(event)
            if (milestone) this.options.onMilestone?.(record, milestone)
        })
        createInterface({ input: child.stderr!, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
            record.stderrTail.push(line)
            if (record.stderrTail.length > STDERR_TAIL) record.stderrTail.shift()
        })
        child.once("error", (error) => {
            record.stderrTail.push(`spawn failed: ${error.message}`)
        })
        child.once("exit", (code) => {
            record.exitCode = code
            record.finishedAt = Date.now()
            const summary = record.tracker.summary()
            record.terminal = resolveTerminal(record.terminal === "aborted", code, summary.done)
            this.children.delete(record.id)
            if (this.active.get(record.cwd) === record.id) this.active.delete(record.cwd)
            this.options.onFinished?.(record, renderOutcome(summary, record.terminal))
            this.startNext(record.cwd)
        })
    }

    private startNext(cwd: string): void {
        const queue = this.queues.get(cwd) ?? []
        const next = queue.shift()
        if (!next) return
        this.start(next)
        this.options.onStarted?.(next, null)
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
    const from = run.startedAt ?? run.queuedAt
    const ms = (run.finishedAt ?? Date.now()) - from
    const s = Math.floor(ms / 1000)
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}
