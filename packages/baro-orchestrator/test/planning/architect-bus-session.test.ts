import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    AgenticEnvironment,
    BaseObserver,
    FunctionCallItem,
    ModelMessageItem,
    type ContextItem,
    type GenerativeModel,
    type ModelContext,
} from "../../src/runtime/mozaik.js"
import {
    ScoutFindingPublished,
    type SemanticEvent,
} from "../../src/semantic-events.js"
import { runArchitectBusSession } from "../../src/planning/adapters/architect-bus-session.js"
import { MozaikModelParticipant } from "../../src/harness/mozaik/model-participant.js"
import { registerLane } from "../../src/harness/lane-registry.js"
import type { InteractiveLaneAdapter, LaneGrant } from "../../src/harness/lane-adapter.js"
import type {
    InteractiveModelParticipant,
    InteractiveParticipantRequest,
} from "../../src/harness/interactive-participant.js"
import { withTempDir } from "../execution/helpers.js"

class Capture extends BaseObserver {
    readonly events: SemanticEvent<unknown>[] = []
    override onExternalEvent(_source: unknown, event: SemanticEvent<unknown>): void {
        this.events.push(event)
    }
}

/**
 * One fake CLI serving both roles. The Architect asks once, reads the answers
 * it gets back, and only then produces an outcome — first a rejected one, so
 * the correction path is exercised too. Scouts answer their own question.
 */
function writeFakeClaude(dir: string): string {
    const path = join(dir, "fake-architect-claude.mjs")
    writeFileSync(
        path,
        `#!/usr/bin/env node
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const systemAt = argv.indexOf("--system-prompt");
const system = systemAt >= 0 ? argv[systemAt + 1] : "";
const isScout = system.includes("repository scout");

process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\\n");
const emit = (text) => process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: text, session_id: "s",
}) + "\\n");

const lines = createInterface({ input: process.stdin });
let turn = 0;
for await (const line of lines) {
    const event = JSON.parse(line);
    if (event.type !== "user") continue;
    const content = event.message?.content ?? "";
    turn += 1;
    if (isScout) {
        emit("scout answer for: " + content.slice(0, 24) + " (src/x.ts:7)");
        continue;
    }
    if (turn === 1) {
        if (!content.includes("say what you must learn")) {
            throw new Error("the Architect's first turn must be the research turn");
        }
        emit(JSON.stringify({ questions: [
            { question: "Which module owns menu visibility today?" },
            { question: "Where is the pagination convention defined?" },
        ] }));
        continue;
    }
    if (turn === 2) {
        if (!content.includes("scout answer for")) {
            throw new Error("the Architect must receive the scouts' answers");
        }
        // Deliberately invalid: exercises the host's correction path.
        emit("NOT-AN-OUTCOME");
        continue;
    }
    if (!content.includes("rejected")) {
        throw new Error("a rejected outcome must come back as a correction");
    }
    emit("Here is my outcome: " + JSON.stringify({ ok: true, saw: "scout answer" }));
}
process.exit(0);
`,
    )
    chmodSync(path, 0o755)
    return path
}

/** The scripted half of the native lane: one participant, no network. */
class ScriptedNativeParticipant extends MozaikModelParticipant {
    private turn = 0

    constructor(agentId: string, private readonly scout: boolean) {
        super({
            agentId,
            model: {
                specification: { name: "scripted" },
                setTools: () => {},
            } as unknown as GenerativeModel,
            systemPrompt: "scripted",
        })
    }

    protected override async runRound(
        context: ModelContext,
    ): Promise<{ items: ContextItem[] }> {
        const shown = JSON.stringify(context.getItems())
        const say = (text: string): { items: ContextItem[] } => ({
            items: [ModelMessageItem.rehydrate({ text })],
        })
        this.turn += 1
        if (this.scout) return say("scout answer for this question (src/x.ts:7)")
        if (this.turn === 1) {
            assert.match(shown, /say what you must learn/u)
            return say(
                JSON.stringify({
                    questions: [
                        { question: "Which module owns menu visibility today?" },
                        { question: "Where is the pagination convention defined?" },
                    ],
                }),
            )
        }
        if (this.turn === 2) {
            assert.match(shown, /scout answer for/u)
            return say("NOT-AN-OUTCOME")
        }
        assert.match(shown, /rejected/u)
        return say(
            "Here is my outcome: " + JSON.stringify({ ok: true, saw: "scout answer" }),
        )
    }
}

class ScriptedNativeLane implements InteractiveLaneAdapter {
    readonly backend = "fake-native"

    async grant(): Promise<LaneGrant> {
        return { close: async () => {} }
    }

    create(
        request: InteractiveParticipantRequest,
    ): InteractiveModelParticipant<unknown> {
        return new ScriptedNativeParticipant(
            request.agentId,
            request.systemPrompt.includes("repository scout"),
        ) as unknown as InteractiveModelParticipant<unknown>
    }
}

/** An Architect that would read forever, and scouts that answer at once. */
class EndlessReaderParticipant extends MozaikModelParticipant {
    constructor(agentId: string, private readonly scout: boolean) {
        super({
            agentId,
            model: {
                specification: { name: "scripted" },
                setTools: () => {},
            } as unknown as GenerativeModel,
            systemPrompt: "scripted",
            tools: [
                {
                    type: "function",
                    name: "read_file",
                    description: "read",
                    parameters: { type: "object", properties: {} },
                    invoke: async () => "some file",
                } as unknown as never,
            ],
            maxRoundsPerTurn: 4,
        })
    }

    protected override async runRound(
        context: ModelContext,
    ): Promise<{ items: ContextItem[] }> {
        const items = context.getItems()
        const last = JSON.stringify(items[items.length - 1] ?? {})
        if (this.scout) {
            return { items: [ModelMessageItem.rehydrate({ text: "scout answer (src/x.ts:7)" })] }
        }
        // Only the host's refusal stops it reading; then it asks, and once the
        // findings come back it produces the outcome.
        if (/scout answer/u.test(last)) {
            return {
                items: [
                    ModelMessageItem.rehydrate({
                        text: "Here is my outcome: " + JSON.stringify({ ok: true }),
                    }),
                ],
            }
        }
        if (/budget for this turn is spent/u.test(last)) {
            return {
                items: [
                    ModelMessageItem.rehydrate({
                        text: JSON.stringify({
                            questions: [{ question: "Which module owns visibility?" }],
                        }),
                    }),
                ],
            }
        }
        return {
            items: [
                FunctionCallItem.rehydrate({
                    callId: `call-${items.length}`,
                    name: "read_file",
                    args: JSON.stringify({ path: "src/a.ts" }),
                }),
            ],
        }
    }
}

class EndlessReaderLane implements InteractiveLaneAdapter {
    readonly backend = "fake-reader"

    async grant(): Promise<LaneGrant> {
        return { close: async () => {} }
    }

    create(
        request: InteractiveParticipantRequest,
    ): InteractiveModelParticipant<unknown> {
        return new EndlessReaderParticipant(
            request.agentId,
            request.systemPrompt.includes("repository scout"),
        ) as unknown as InteractiveModelParticipant<unknown>
    }
}

describe("architect bus session", () => {
    it("asks, reads the answers, and repairs a rejected outcome", async () => {
        await withTempDir("baro-architect-bus-", async (dir) => {
            const env = new AgenticEnvironment("architect-bus-test")
            const capture = new Capture()
            capture.join(env)
            const lines: string[] = []
            const previousPlanEvents = process.env.BARO_PLAN_EVENTS
            const previousWrite = process.stdout.write.bind(process.stdout)
            process.env.BARO_PLAN_EVENTS = "1"
            process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
                lines.push(String(chunk))
                return (previousWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
            }) as typeof process.stdout.write

            const result = await runArchitectBusSession({
                systemPrompt: "You are the architect for this engineering run.",
                userMessage: "Migrate validation to zod.",
                goal: "Migrate validation to zod.",
                cwd: dir,
                claudeBin: writeFakeClaude(dir),
                environment: env,
                roundBudgetMs: 20_000,
                normalizeOutcome: (raw) => raw.slice(raw.indexOf("{")),
                validateOutcome: (raw) => {
                    const parsed = JSON.parse(raw) as { ok?: unknown }
                    if (parsed.ok !== true) throw new Error("outcome must state ok:true")
                },
            })
            process.stdout.write = previousWrite
            if (previousPlanEvents === undefined) delete process.env.BARO_PLAN_EVENTS
            else process.env.BARO_PLAN_EVENTS = previousPlanEvents

            assert.equal(result.researchRounds, 1)
            assert.equal(result.outcomeAttempts, 2, "the rejected outcome was repaired")
            assert.equal(result.findings.length, 2)
            assert.ok(result.findings.every((finding) => finding.ok))
            assert.match(result.outcome, /"saw":"scout answer"/)

            const published = capture.events.filter(ScoutFindingPublished.is)
            assert.equal(
                published.length,
                2,
                "the Architect's research is on the same bus, as events",
            )
            // Research also reaches the run stream a human actually watches.
            const narrated = lines.filter((line) => line.includes("scout"))
            assert.ok(
                narrated.some((line) => line.includes("scout dispatched")),
                "each question is narrated to the run",
            )
            assert.ok(
                narrated.some((line) => line.includes("scout answered")),
                "each answer is narrated to the run",
            )
        })
    })

    /**
     * The same phase on the lane that has no process, with only the provider
     * call scripted — the participant, the reply stream and the research board
     * are the real ones.
     *
     * Five live DeepSeek runs died here and no test could see it: the phase
     * held its connection open, every round returned, and the session heard
     * nothing, because a native turn published no terminal event and every
     * session settles on one.
     */
    it("completes on a lane with no process, not only on the CLI", async () => {
        await withTempDir("baro-architect-bus-native-", async (dir) => {
            registerLane("fake-native", () => new ScriptedNativeLane())
            const env = new AgenticEnvironment("architect-bus-native-test")
            const capture = new Capture()
            capture.join(env)

            const result = await runArchitectBusSession({
                systemPrompt: "You are the architect for this engineering run.",
                userMessage: "Migrate validation to zod.",
                goal: "Migrate validation to zod.",
                cwd: dir,
                backend: "fake-native",
                environment: env,
                roundBudgetMs: 20_000,
                normalizeOutcome: (raw) => raw.slice(raw.indexOf("{")),
                validateOutcome: (raw) => {
                    const parsed = JSON.parse(raw) as { ok?: unknown }
                    if (parsed.ok !== true) throw new Error("outcome must state ok:true")
                },
            })

            assert.equal(result.researchRounds, 1)
            assert.equal(result.outcomeAttempts, 2, "the rejected outcome was repaired")
            assert.equal(result.findings.length, 2)
            assert.ok(result.findings.every((finding) => finding.ok))
            assert.match(result.outcome, /"saw":"scout answer"/)
            assert.equal(
                capture.events.filter(ScoutFindingPublished.is).length,
                2,
                "scouts answer as participants on this lane too",
            )
        })
    })

    // A model with a repository and a way to ask others to read it tends to
    // read: a live GLM-5.2 Architect spent seventeen rounds surveying and sent
    // no scout a single question. The turn's budget is what bounds the look.
    it("stops surveying and asks, when the turn's budget is spent", async () => {
        await withTempDir("baro-architect-bus-budget-", async (dir) => {
            registerLane("fake-reader", () => new EndlessReaderLane())
            const env = new AgenticEnvironment("architect-bus-budget-test")

            const result = await runArchitectBusSession({
                systemPrompt: "You are the architect for this engineering run.",
                userMessage: "Migrate validation to zod.",
                goal: "Migrate validation to zod.",
                cwd: dir,
                backend: "fake-reader",
                environment: env,
                roundBudgetMs: 20_000,
                normalizeOutcome: (raw) => raw.slice(raw.indexOf("{")),
                validateOutcome: (raw) => {
                    if ((JSON.parse(raw) as { ok?: unknown }).ok !== true) {
                        throw new Error("outcome must state ok:true")
                    }
                },
            })

            // It read until it was told to stop, then asked — and the scouts
            // ran, which is the whole point of the phase.
            assert.equal(result.researchRounds, 1)
            assert.equal(result.findings.length, 1)
            assert.ok(result.findings[0]!.ok)
        })
    })

    it("goes straight to the outcome when the Architect asks nothing", async () => {
        await withTempDir("baro-architect-bus-direct-", async (dir) => {
            const path = join(dir, "silent-claude.mjs")
            writeFileSync(
                path,
                `#!/usr/bin/env node
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
    const event = JSON.parse(line);
    if (event.type !== "user") continue;
    process.stdout.write(JSON.stringify({
        type: "result", subtype: "success", is_error: false,
        result: JSON.stringify({ ok: true }), session_id: "s",
    }) + "\\n");
}
process.exit(0);
`,
            )
            chmodSync(path, 0o755)

            const result = await runArchitectBusSession({
                systemPrompt: "architect",
                userMessage: "Small fix.",
                goal: "Small fix.",
                cwd: dir,
                claudeBin: path,
                validateOutcome: (raw) => {
                    if ((JSON.parse(raw) as { ok?: unknown }).ok !== true) {
                        throw new Error("outcome must state ok:true")
                    }
                },
            })
            assert.equal(result.researchRounds, 0)
            assert.equal(result.findings.length, 0)
            assert.equal(result.outcomeAttempts, 1)
        })
    })
})
