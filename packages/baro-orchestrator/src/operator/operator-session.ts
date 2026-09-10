import { AgenticEnvironment, BaseObserver } from "../runtime/mozaik.js"
import type { Participant, SemanticEvent } from "../runtime/mozaik.js"
import { AgentResult, ClaudeStreamChunk } from "../events/harness-stream.js"
import { ClaudeCliParticipant } from "../harness/claude/cli-participant.js"
import type { HostFunction } from "../harness/lane-adapter.js"
import { HostToolsRelay, OPERATOR_MCP_SERVER_NAME } from "./host-tools-relay.js"
import { RunRegistry } from "./run-registry.js"
import type { OperatorUi, TurnResult } from "./ui.js"

/* One conversation that outlives its runs. Claude Code is the operator: it
   answers, edits directly, or delegates to baro, and says which. Everything
   baro does arrives here as protocol events, so "what are they doing" is a
   question the operator can answer from the registry, not from a log. The
   surface is a port: the same session drives a terminal or the Rust TUI. */

export interface OperatorOptions {
    readonly cwd: string
    readonly model?: string
    readonly effort?: string
    readonly claudeBin?: string
    /** `ask` routes Claude's permission prompts to the surface; `auto` bypasses them. */
    readonly permission: "ask" | "auto"
    readonly baroArgs?: readonly string[]
}

const AGENT_ID = "operator"
// Measured 9.9.2026: the operator built a four-file CLI with tests in under a
// minute, while baro spent seven on intake and architect for three helpers.
// Direct work is capped where it stops being one component; past that the
// edit is refused with the remedy.
const DIRECT_FILE_LIMIT = 10

export async function runOperator(options: OperatorOptions, ui: OperatorUi): Promise<void> {
    const registry = new RunRegistry({
        ...(options.baroArgs ? { baroArgs: options.baroArgs } : {}),
        onStarted: (run) => {
            ui.note(`${run.id} · started (was queued)`)
            ui.runsChanged(registry.rows())
            participant.sendUserMessage(
                `[baro] ${run.id} left the queue and is now running. Tell the user in one sentence.`,
            )
        },
        onMilestone: (run, line) => {
            ui.note(`${run.id} · ${line}`)
            ui.runsChanged(registry.rows())
        },
        onFinished: (run, outcome) => {
            ui.note(`${run.id} · finished (${run.terminal})`)
            ui.runsChanged(registry.rows())
            participant.sendUserMessage(
                `[baro] ${run.id} finished.\n${outcome}\n\nTell the user in two or three sentences what happened and what they can do next.`,
            )
        },
    })

    const alwaysAllowed = new Set<string>()
    const editedThisTurn = new Set<string>()
    // The surface answers one question at a time, in order.
    let askChain: Promise<unknown> = Promise.resolve()
    const ask = (prompt: string, meta: Parameters<OperatorUi["ask"]>[1]): Promise<string> => {
        const turn = askChain.then(() => ui.ask(prompt, meta))
        askChain = turn.catch(() => undefined)
        return turn
    }

    const functions: HostFunction[] = [
        {
            name: "delegate",
            description:
                "Start a baro run in the background for a multi-story goal. Returns the run id at once; the run keeps going while the conversation continues.",
            parameters: {
                type: "object",
                properties: {
                    goal: {
                        type: "string",
                        description:
                            "Self-contained goal: what to build, where, constraints, how to verify. baro's planner reads only this.",
                    },
                    cwd: { type: "string", description: "Repository path; defaults to the session repository." },
                },
                required: ["goal"],
                additionalProperties: false,
            },
            invoke: async (args) => {
                const { goal, cwd } = args as { goal?: unknown; cwd?: unknown }
                if (typeof goal !== "string" || !goal.trim()) throw new Error("delegate requires a goal")
                const { run, behind } = registry.delegate(
                    goal.trim(),
                    typeof cwd === "string" && cwd ? cwd : options.cwd,
                )
                ui.runsChanged(registry.rows())
                if (behind) {
                    ui.note(`${run.id} · queued behind ${behind.id}: ${run.goal.slice(0, 80)}`)
                    return `${run.id} queued behind ${behind.id}: baro allows one run per repository at a time, so it starts automatically the moment ${behind.id} exits. Tell the user it is queued, not running. stop ${behind.id} only if the user asks for that.`
                }
                ui.note(`${run.id} · delegated: ${run.goal.slice(0, 90)}`)
                return `${run.id} started in the background (cwd ${run.cwd}). Intake and planning take a few minutes before stories start; ask run_status for progress.`
            },
        },
        {
            name: "runs",
            description: "List every run of this session with state, phase and progress.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            invoke: async () => registry.table(),
        },
        {
            name: "run_status",
            description: "Where one run is: phase, stories done/total, last activity, recent milestones, or its outcome.",
            parameters: {
                type: "object",
                properties: { run_id: { type: "string" } },
                required: ["run_id"],
                additionalProperties: false,
            },
            invoke: async (args) => registry.status(String((args as { run_id?: unknown }).run_id ?? "")),
        },
        {
            name: "stop",
            description: "Stop a running baro run. Work already merged stays on the branch.",
            parameters: {
                type: "object",
                properties: { run_id: { type: "string" } },
                required: ["run_id"],
                additionalProperties: false,
            },
            invoke: async (args) => {
                const id = String((args as { run_id?: unknown }).run_id ?? "")
                const stopped = registry.stop(id)
                ui.runsChanged(registry.rows())
                return stopped ? `${id} stopping` : `${id} is not running`
            },
        },
    ]
    if (options.permission === "ask") {
        functions.push({
            name: "permission",
            description: "Internal: asks the person at the surface before a tool runs.",
            parameters: {
                type: "object",
                properties: { tool_name: { type: "string" }, input: { type: "object" } },
                required: ["tool_name", "input"],
            },
            invoke: async (args) => {
                const { tool_name: tool, input } = args as { tool_name?: string; input?: unknown }
                const name = tool ?? "tool"
                const summary = summarizeToolInput(name, input)
                if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
                    if (summary && !editedThisTurn.has(summary) && editedThisTurn.size >= DIRECT_FILE_LIMIT) {
                        ui.note(`✋ ${name} ${summary} refused: direct work is capped at ${DIRECT_FILE_LIMIT} files per turn`)
                        return JSON.stringify({
                            behavior: "deny",
                            message:
                                `This change now spans more than ${DIRECT_FILE_LIMIT} files (${[...editedThisTurn, summary].join(", ")}). ` +
                                "That is delegate altitude: stop editing, revert nothing, and call the delegate tool with a self-contained goal that includes the files you already touched.",
                        })
                    }
                    if (summary) editedThisTurn.add(summary)
                }
                if (alwaysAllowed.has(name)) {
                    return JSON.stringify({ behavior: "allow", updatedInput: input })
                }
                const answer = await ask("allow?", {
                    kind: "permission",
                    tool: name,
                    summary,
                    options: ["y", "N", `a=always for ${name}`],
                })
                if (answer === "a" || answer === "always") alwaysAllowed.add(name)
                if (answer === "y" || answer === "yes" || answer === "a" || answer === "always") {
                    return JSON.stringify({ behavior: "allow", updatedInput: input })
                }
                return JSON.stringify({ behavior: "deny", message: "the user declined" })
            },
        })
    }

    const relay = new HostToolsRelay(functions, "baro operator tools")
    const connection = await relay.open()
    for (const [name, value] of Object.entries(connection.env)) process.env[name] = value

    const toolNames = functions
        .filter((fn) => fn.name !== "permission")
        .map((fn) => `mcp__${OPERATOR_MCP_SERVER_NAME}__${fn.name}`)
    const participant = new ClaudeCliParticipant(AGENT_ID, {
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.claudeBin ? { claudeBin: options.claudeBin } : {}),
        includePartialMessages: true,
        replayUserMessages: false,
        permissionMode: options.permission === "ask" ? "default" : "bypassPermissions",
        extraArgs: [
            "--strict-mcp-config",
            "--mcp-config",
            JSON.stringify({
                mcpServers: {
                    [OPERATOR_MCP_SERVER_NAME]: {
                        type: "stdio",
                        command: connection.command,
                        args: connection.args,
                        // Claude expands ${VAR} from its own environment, so
                        // the relay secret never enters argv.
                        env: Object.fromEntries(Object.keys(connection.env).map((n) => [n, `\${${n}}`])),
                    },
                },
            }),
            "--allowed-tools",
            toolNames.join(","),
            // A dialog nobody can render: the CLI reports it dismissed and the
            // model picks a default on its own. Questions go through text.
            "--disallowed-tools",
            "AskUserQuestion",
            ...(options.permission === "ask"
                ? ["--permission-prompt-tool", `mcp__${OPERATOR_MCP_SERVER_NAME}__permission`]
                : []),
            "--system-prompt",
            systemPrompt(options.cwd),
        ],
    })

    const env = new AgenticEnvironment("baro-operator")
    const renderer = new Renderer(ui, (result) => {
        editedThisTurn.clear()
        ui.turnDone(result)
    })
    renderer.join(env)
    participant.join(env)
    participant.start(env)

    ui.banner(`baro operator · ${options.model ?? "default model"} · ${options.cwd}`)

    let closing = false
    const shutdown = async (stopRuns: boolean | undefined): Promise<void> => {
        if (closing) return
        closing = true
        const running = registry.running()
        if (running.length > 0) {
            let stop = stopRuns
            if (stop === undefined) {
                const answer = await ask(
                    `${running.length} run(s) still running (${running.map((r) => r.id).join(", ")}). stop them?`,
                    { kind: "quit", options: ["y", "N"] },
                )
                stop = answer === "y" || answer === "yes"
            }
            if (stop) for (const run of running) registry.stop(run.id)
            else ui.note("leaving them running; stop later with: baro stop <id>")
        }
        participant.closeStdin()
        await Promise.race([participant.done, new Promise((r) => setTimeout(r, 4_000))])
        await participant.abortAndWait()
        await relay.close()
        ui.close()
        process.exit(0)
    }

    ui.onCommand((command) => {
        switch (command.type) {
            case "quit":
                void shutdown(command.stopRuns)
                return
            case "runs":
                ui.note(registry.table())
                return
            case "status":
                ui.note(registry.status(command.id))
                return
            case "stop": {
                const stopped = registry.stop(command.id)
                ui.runsChanged(registry.rows())
                ui.note(stopped ? `${command.id} stopping` : `${command.id} is not running`)
                return
            }
            case "user":
                participant.sendUserMessage(command.text)
                return
        }
    })

    await participant.done
    if (!closing) {
        ui.note(`operator session ended: ${participant.sessionEndDetail()}`)
        await relay.close()
        ui.close()
        process.exit(1)
    }
}

class Renderer extends BaseObserver {
    /** Tool calls in flight, by content block index; input arrives as JSON deltas. */
    private readonly toolBlocks = new Map<number, { name: string; json: string }>()

    constructor(
        private readonly ui: OperatorUi,
        private readonly onResult: (result: TurnResult) => void,
    ) {
        super()
    }

    override onExternalEvent(_source: Participant, event: SemanticEvent<unknown>): void {
        if (ClaudeStreamChunk.is(event)) {
            this.render(event.data.raw)
            return
        }
        if (AgentResult.is(event) && event.data.agentId === AGENT_ID) {
            this.onResult({ durationMs: event.data.durationMs, totalCostUsd: event.data.totalCostUsd })
        }
    }

    private render(raw: Readonly<Record<string, unknown>>): void {
        if (raw.type !== "stream_event") return
        const inner = raw.event as Record<string, unknown> | undefined
        if (!inner) return
        const index = typeof inner.index === "number" ? inner.index : -1
        const delta = inner.delta as Record<string, unknown> | undefined
        switch (inner.type) {
            case "content_block_start": {
                const block = inner.content_block as Record<string, unknown> | undefined
                if (block?.type === "tool_use") {
                    this.toolBlocks.set(index, { name: String(block.name ?? "tool"), json: "" })
                }
                return
            }
            case "content_block_delta": {
                if (delta?.type === "text_delta") {
                    this.ui.stream(String(delta.text ?? ""))
                } else if (delta?.type === "input_json_delta") {
                    const pending = this.toolBlocks.get(index)
                    if (pending) pending.json += String(delta.partial_json ?? "")
                }
                return
            }
            case "content_block_stop": {
                const pending = this.toolBlocks.get(index)
                if (!pending) return
                this.toolBlocks.delete(index)
                let input: unknown = {}
                try {
                    input = pending.json ? JSON.parse(pending.json) : {}
                } catch {
                    input = {}
                }
                const name = pending.name.replace(`mcp__${OPERATOR_MCP_SERVER_NAME}__`, "baro ")
                this.ui.toolCall(name, summarizeToolInput(name, input))
                return
            }
            default:
                return
        }
    }
}

function summarizeToolInput(name: string, input: unknown): string {
    const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
    const pick = (...keys: string[]): string => {
        for (const key of keys) {
            const value = record[key]
            if (typeof value === "string" && value) return value
        }
        return ""
    }
    const text = pick("file_path", "command", "pattern", "goal", "run_id", "path", "url")
    const single = text.replace(/\s+/g, " ")
    return single.length > 100 ? `${single.slice(0, 99)}…` : single
}

function systemPrompt(cwd: string): string {
    return `You are baro's operator: a coding agent working inside the repository at ${cwd}, with baro as your back office. baro runs multi-story goals as a verified pipeline (architect, planner, parallel coding agents, independent per-story review, verification, pull request) in the background through the \`delegate\` tool.

Every request gets an altitude. Your FIRST line of every reply is the altitude and a short reason, e.g. "direct — one component, eight files, tests exist." Decide before you touch anything; reading a file or two to decide is fine.
- answer: questions, explanations, lookups. Reply directly.
- direct: one component you can finish in roughly ten minutes, clear intent, typically up to eight files. Do it yourself like a normal coding agent: edit, run the relevant tests, say what changed. Finish the whole thing in one turn; do not split a job to stay under a limit. Do not commit unless asked. Never push and never open a pull request yourself. The host refuses the eleventh file in one turn as a runaway-scope guard; if you hit it, delegate the rest.
- delegate: work whose scope you cannot see to the end, changes across several modules or owned by different people, anything that needs independent review and a verified pull request, or anything the user asks to run through baro. baro has a fixed cost: intake, architect and goal contract take ten to fifteen minutes before the first story starts, whatever the size. So for a goal you could finish directly in a few minutes, say so and offer the choice in one line ("direct in ~3 min, or baro in ~15 with review and a PR?") instead of delegating by default. When you delegate, call \`delegate\` with a precise, self-contained goal (what, where, constraints, how to verify); baro's planner reads only that text. Warn first if the working tree has uncommitted changes the goal depends on: baro's agents work from the last commit. It returns at once with a run id and the run continues in the background. Do not poll in a loop. Tell the user the run id and one sentence on what to expect, then keep talking.

When asked what the agents are doing, call \`run_status\` (or \`runs\`) and summarize plainly: phase, stories done of total, last activity, recent milestones. When a run finishes you receive a message starting with [baro]; report the outcome and the pull request link if there is one. If the user overrides your altitude ("just do it yourself" / "send it to baro"), follow them.

There is no dialog tool here: when you need a decision from the user (which altitude, whether to commit first, an ambiguity), ask in one or two plain sentences and END YOUR TURN. Never pick a default on the user's behalf for a question you just asked.

Keep replies short and concrete.`
}
