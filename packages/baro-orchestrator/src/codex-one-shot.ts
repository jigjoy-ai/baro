/**
 * Shared helper: run a one-shot `codex exec --json` invocation against
 * a single combined prompt, collect the JSONL stream, and return the
 * concatenated `agent_message` text. Used by `architect-codex.ts`,
 * `planner-codex.ts`, `critic-codex.ts`, and `surgeon-codex.ts` so the
 * spawn + parse logic lives in one place.
 *
 * Codex exec doesn't have separate `--system-prompt` / `-p` flags the
 * way `claude --print` does — the whole prompt is one positional argv.
 * Callers therefore concatenate the system + user message themselves
 * (typically `${SYSTEM}\n\n${USER}`) and pass the result here.
 */

import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export interface RunCodexOneShotOptions {
    /** Combined system+user prompt. Passed as the final positional argv. */
    prompt: string
    /** Working directory. Must be a git repo (Codex enforces) unless
     *  skipGitRepoCheck=true. */
    cwd: string
    /** Model identifier. Defaults to Codex's own pick (gpt-5.5 on Plus+). */
    model?: string
    /** Bypass Codex's sandbox + approval prompts. Default: true (callers
     *  here are all one-shot architect/planner/critic/surgeon LLM calls
     *  that need to be autonomous). */
    bypassSandbox?: boolean
    /** Skip the "must be inside a git repo" check. Default: false. */
    skipGitRepoCheck?: boolean
    /** Path to the `codex` binary. Default: "codex" (resolved via PATH). */
    codexBin?: string
    /** Per-call timeout in milliseconds. Default: 180_000 (3 minutes). */
    timeoutMs?: number
    /** Max stdout buffer. Default: 16 MB. */
    maxBuffer?: number
}

/**
 * Spawn `codex exec --json <prompt>`, collect every JSONL line, and
 * return the concatenated `agent_message` text. Throws if Codex returns
 * no agent message (e.g. exited before emitting one) or if the
 * subprocess fails / times out.
 *
 * Token usage from the trailing `turn.completed` envelope is logged to
 * stderr so callers can observe per-phase Codex spend.
 */
export async function runCodexOneShot(
    opts: RunCodexOneShotOptions,
): Promise<string> {
    const args = ["exec", "--json"]
    if (opts.skipGitRepoCheck) args.push("--skip-git-repo-check")
    if (opts.bypassSandbox !== false) {
        // Default-on (see option doc) — every caller here is autonomous.
        args.push("--dangerously-bypass-approvals-and-sandbox")
    }
    if (opts.model) args.push("--model", opts.model)
    args.push(opts.prompt)

    const { stdout } = await execFileAsync(opts.codexBin ?? "codex", args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 180_000,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    })

    let result = ""
    for (const rawLine of stdout.split("\n")) {
        const line = rawLine.trim()
        if (!line) continue
        let event: Record<string, unknown>
        try {
            event = JSON.parse(line) as Record<string, unknown>
        } catch {
            continue
        }
        if (event.type === "turn.completed") {
            const usage = event.usage as
                | { input_tokens?: number; output_tokens?: number }
                | undefined
            if (usage) {
                process.stderr.write(
                    `[codex] usage: in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0}\n`,
                )
            }
            continue
        }
        if (event.type !== "item.completed") continue
        const item = event.item as Record<string, unknown> | undefined
        if (!item) continue
        if (item.type === "agent_message" && typeof item.text === "string") {
            // Concatenate in case Codex emits multiple agent_message items
            // (rare in practice — usually one terminal message — but the
            // doc allows it). Newline-joined so downstream JSON-extractor
            // still finds a balanced object.
            result = result ? `${result}\n${item.text}` : item.text
        }
    }

    if (!result.trim()) {
        throw new Error("runCodexOneShot: codex produced no agent_message")
    }
    return result
}
