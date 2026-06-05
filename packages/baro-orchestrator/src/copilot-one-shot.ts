/**
 * Shared helper: run a one-shot `copilot -p <PROMPT> --output-format json`
 * invocation against a single combined prompt, collect the JSONL stream,
 * and return the concatenated assistant text. Used by
 * `architect-copilot.ts`, `planner-copilot.ts`, `critic-copilot.ts`, and
 * `surgeon-copilot.ts` so the spawn + parse logic lives in one place.
 *
 * Copilot is a one-shot, non-interactive CLI: `-p` runs the prompt and the
 * process exits when done (nonzero on LLM error), exactly like
 * `codex exec` / `opencode run`. This file is copied from
 * `codex-one-shot.ts` and adjusted for Copilot's flags.
 *
 * The `--output-format json` event schema is UNDOCUMENTED. Field names used
 * below for text extraction are provisional and refined once
 * `probe-copilot.ts` captures the real JSONL from the binary. Until then,
 * extraction is deliberately defensive: any unrecognized envelope is simply
 * ignored here (the stream mapper, not this helper, owns the
 * never-drop/CopilotUnknownEvent invariant).
 *
 * Implementation note: uses `spawn()` + streaming rather than
 * `execFile()` + buffer because execFile discards stdout on timeout.
 * Streaming lets us:
 *   - forward Copilot's structured events to stderr live so the audit
 *     log captures them even on timeout
 *   - track which event subtypes were observed for the error message
 *   - kill Copilot with SIGTERM on timeout instead of execFile's harsher
 *     SIGTERM-then-SIGKILL escalation
 */

import { ChildProcess, spawn } from "child_process"

/**
 * Clamp a raw baro effort value to the set Copilot's `--reasoning-effort`
 * accepts. baro's effort values are `low|medium|high|xhigh|max`; Copilot
 * accepts only `low|medium|high`.
 *
 * This is the SINGLE source of the effort mapping — both
 * `runCopilotOneShot` here and `CopilotCliParticipant.buildArgs()` import
 * it so the participant and the one-shot can never disagree.
 *
 *   xhigh -> high, max -> high
 *   low / medium / high -> pass through
 *   anything else (undefined, "", unknown) -> undefined (omit the flag)
 */
export function clampCopilotEffort(effort?: string): string | undefined {
    switch (effort) {
        case "low":
        case "medium":
        case "high":
            return effort
        case "xhigh":
        case "max":
            return "high"
        default:
            return undefined
    }
}

export interface RunCopilotOneShotOptions {
    /** Combined system+user prompt. Passed as the value of `-p`. */
    prompt: string
    /** Working directory for the Copilot process. */
    cwd: string
    /** Model identifier. Omit to let Copilot use its default (claude-sonnet-4.5). */
    model?: string
    /**
     * Raw baro effort value (`low|medium|high|xhigh|max`). Clamped via
     * `clampCopilotEffort` before being passed as `--reasoning-effort`;
     * omitted entirely when it clamps to undefined.
     */
    effort?: string
    /** Path to the `copilot` binary. Default: "copilot". */
    copilotBin?: string
    /** Per-call timeout in milliseconds. Default: 600_000 (10 minutes). */
    timeoutMs?: number
    /**
     * Per-phase label written into the live stderr stream so users can
     * tell architect/planner/critic/surgeon traffic apart in one log
     * tail. Defaults to "copilot".
     */
    label?: string
}

/**
 * Spawn `copilot -p <PROMPT> --output-format json --yolo --no-ask-user`,
 * collect the assistant text from the JSONL stream, and return it.
 *
 * `--yolo` + `--no-ask-user` are always present: baro runs in per-story git
 * worktrees, so auto-approving tools and never pausing for input is the
 * correct autonomous posture (mirroring the Codex `bypassSandbox` rationale).
 *
 * @throws Error if the process terminates abnormally or produces no text.
 */
export async function runCopilotOneShot(
    opts: RunCopilotOneShotOptions,
): Promise<string> {
    const label = opts.label ?? "copilot"
    const args = [
        "-p",
        opts.prompt,
        "--output-format",
        "json",
        "--yolo",
        "--no-ask-user",
    ]
    if (opts.model) args.push("--model", opts.model)
    const effort = clampCopilotEffort(opts.effort)
    if (effort) args.push("--reasoning-effort", effort)

    const timeoutMs = opts.timeoutMs ?? 600_000

    return await new Promise<string>((resolve, reject) => {
        let proc: ChildProcess
        try {
            proc = spawn(opts.copilotBin ?? "copilot", args, {
                cwd: opts.cwd,
                stdio: ["ignore", "pipe", "pipe"],
            })
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
            return
        }

        let assistantText = ""
        let stdoutBuffer = ""
        const eventTypesSeen: string[] = []
        let timedOut = false

        const startedAt = Date.now()
        const timer = setTimeout(() => {
            timedOut = true
            try {
                proc.kill("SIGTERM")
            } catch {
                /* noop */
            }
        }, timeoutMs)

        proc.stdout!.setEncoding("utf8")
        proc.stdout!.on("data", (chunk: string) => {
            stdoutBuffer += chunk
            let nl: number
            while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
                const line = stdoutBuffer.slice(0, nl).trim()
                stdoutBuffer = stdoutBuffer.slice(nl + 1)
                if (!line) continue
                let event: Record<string, unknown>
                try {
                    event = JSON.parse(line) as Record<string, unknown>
                } catch {
                    continue
                }
                const type = typeof event.type === "string" ? event.type : ""
                if (type) eventTypesSeen.push(type)

                // Provisional text extraction pending probe-copilot.ts. Pull
                // any assistant/message text we can recognize; unknown shapes
                // are ignored here (the mapper preserves them downstream).
                const text = extractAssistantText(event)
                if (text) {
                    assistantText = assistantText
                        ? `${assistantText}\n${text}`
                        : text
                }
            }
        })

        proc.stderr!.setEncoding("utf8")
        proc.stderr!.on("data", (chunk: string) => {
            const trimmed = chunk.trimEnd()
            if (trimmed) {
                process.stderr.write(`[${label}/stderr] ${trimmed}\n`)
            }
        })

        proc.on("error", (err) => {
            clearTimeout(timer)
            reject(err)
        })

        proc.on("exit", (code, signal) => {
            clearTimeout(timer)
            const elapsedMs = Date.now() - startedAt

            const ctx = [
                `elapsed=${elapsedMs}ms`,
                `exit=${code}`,
                signal ? `signal=${signal}` : null,
                timedOut ? `timedOut=true (cap=${timeoutMs}ms)` : null,
                `events=${eventTypesSeen.length}`,
                eventTypesSeen.length > 0
                    ? `event_types=[${[...new Set(eventTypesSeen)].join(",")}]`
                    : null,
            ]
                .filter((x): x is string => x !== null)
                .join(" ")

            // Copilot `-p` exits nonzero on LLM error, which makes the exit
            // code meaningful. Treat a timeout, a terminating signal, or a
            // non-zero exit as failure even if some text accumulated — the
            // callers feed the returned string into a markdown/JSON extractor
            // that would silently accept a truncated fragment otherwise.
            if (timedOut || signal != null || (code != null && code !== 0)) {
                reject(
                    new Error(
                        `runCopilotOneShot: copilot terminated abnormally before completing (${ctx})`,
                    ),
                )
                return
            }

            if (assistantText.trim()) {
                resolve(assistantText)
                return
            }

            reject(
                new Error(
                    `runCopilotOneShot: copilot produced no text output (${ctx})`,
                ),
            )
        })
    })
}

/**
 * Best-effort assistant-text extraction from a single parsed JSONL event.
 *
 * The Copilot `--output-format json` schema is undocumented, so this probes
 * a small set of plausible field shapes rather than committing to one. It is
 * refined once `probe-copilot.ts` captures the real field names. Returns the
 * empty string when no recognizable text is present.
 */
function extractAssistantText(event: Record<string, unknown>): string {
    const type = typeof event.type === "string" ? event.type : ""
    // Only consider events that look like assistant/message output; skip
    // tool, system, and lifecycle envelopes so we don't fold their payloads
    // into the assistant text.
    if (type && !/message|assistant|text|content/i.test(type)) return ""

    if (typeof event.text === "string") return event.text
    if (typeof event.content === "string") return event.content

    const item = event.item as Record<string, unknown> | undefined
    if (item) {
        if (typeof item.text === "string") return item.text
        if (typeof item.content === "string") return item.content
    }

    const message = event.message as Record<string, unknown> | undefined
    if (message && typeof message.content === "string") return message.content

    return ""
}
