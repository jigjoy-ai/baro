import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    AgenticEnvironment,
    BaseObserver,
    FunctionCallItem,
    ModelMessageItem,
    type ContextItem,
    type GenerativeModel,
    type ModelContext,
    type Participant,
    type SemanticEvent,
} from "../../src/runtime/mozaik.js"
import {
    PlanFragmentAdmitted,
    PlanFragmentProposed,
    PlanningStreamCompleted,
} from "../../src/semantic-events.js"
import { PlanningFeed } from "../../src/execution/planning-feed.js"
import { runPlannerBusSession } from "../../src/planning/adapters/planner-bus-session.js"
import { MozaikModelParticipant } from "../../src/harness/mozaik/model-participant.js"
import { registerLane } from "../../src/harness/lane-registry.js"
import type { InteractiveLaneAdapter, LaneGrant } from "../../src/harness/lane-adapter.js"
import type {
    InteractiveModelParticipant,
    InteractiveParticipantRequest,
} from "../../src/harness/interactive-participant.js"

const GOAL_ENVELOPE = {
    objective: "Add a health endpoint",
    constraints: [],
    acceptanceCriteria: ["GET /health returns 200"],
    nonGoals: [],
    assumptions: [],
}

const FRAGMENT_STORY = {
    id: "S1",
    priority: 1,
    title: "Health endpoint",
    description: "Add GET /health returning 200 with the service name.",
    dependsOn: [],
    retries: 2,
    acceptance: ["GET /health returns 200"],
    tests: ["npm test -- health"],
    goalInvariantIds: [],
    model: "standard",
    writes: ["src/health.controller.ts"],
}

/** Admits every proposed fragment, as the Board would on a clean plan. */
class AlwaysAdmit extends BaseObserver {
    readonly proposed: string[] = []
    private version = 1

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (!PlanFragmentProposed.is(event)) return
        this.proposed.push(event.data.fragmentId)
        const admitted = PlanFragmentAdmitted.create({
            runId: event.data.runId,
            planningId: event.data.planningId,
            fragmentId: event.data.fragmentId,
            graphVersion: ++this.version,
            storyIds: event.data.stories.map(
                (item) => (item as { id: string }).id,
            ),
            droppedEdges: [],
        })
        for (const environment of this.getEnvironments()) {
            environment.deliverSemanticEvent(this, admitted)
        }
    }
}

/**
 * A planner that publishes one fragment and then finalizes — scripted only at
 * the provider call, so the tool call, the receipt and the finalization all
 * travel the real path.
 */
class ScriptedPlanner extends MozaikModelParticipant {
    readonly receipts: string[] = []
    private round = 0

    constructor(agentId: string) {
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
        this.round += 1
        if (this.round === 1) {
            return {
                items: [
                    FunctionCallItem.rehydrate({
                        callId: "call-1",
                        name: "publish_plan_fragment",
                        args: JSON.stringify({
                            fragmentId: "F1",
                            stories: [FRAGMENT_STORY],
                        }),
                    }),
                ],
            }
        }
        // Whatever the host answered is in the context by now; the planner is
        // supposed to read the receipt before it finalizes.
        this.receipts.push(JSON.stringify(context.getItems()))
        return {
            items: [
                ModelMessageItem.rehydrate({
                    text: JSON.stringify({
                        project: "health",
                        branchName: "baro/health",
                        description: "Add a health endpoint",
                        userStories: [],
                    }),
                }),
            ],
        }
    }
}

class ScriptedPlannerLane implements InteractiveLaneAdapter {
    readonly backend = "fake-native-planner"
    planner: ScriptedPlanner | null = null

    async grant(capabilities: readonly unknown[]): Promise<LaneGrant> {
        const { MozaikLaneAdapter } = await import(
            "../../src/harness/mozaik/lane-adapter.js"
        )
        return await new MozaikLaneAdapter({ backend: this.backend }).grant(
            capabilities as never,
        )
    }

    create(
        request: InteractiveParticipantRequest,
        grant: LaneGrant,
    ): InteractiveModelParticipant<unknown> {
        const planner = new ScriptedPlanner(request.agentId)
        // The grant's tools are what the CLI lane would need a relay for.
        ;(planner as unknown as { opts: { tools: unknown } }).opts.tools =
            grant.tools ?? []
        this.planner = planner
        return planner as unknown as InteractiveModelParticipant<unknown>
    }
}

// Progressive planning was the one capability that reached the native lane
// through a different door: the CLI dials a spawned MCP server, this lane is
// handed the function. Only a live run had ever exercised the second door.
describe("progressive planning on a lane with no process", () => {
    it("publishes a fragment, reads the host's receipt, and finalizes", async () => {
        const lane = new ScriptedPlannerLane()
        registerLane("fake-native-planner", () => lane)
        const env = new AgenticEnvironment("planner-bus-native-test")
        const feed = new PlanningFeed()
        const board = new AlwaysAdmit()
        const completed: unknown[] = []
        const watcher = new (class extends BaseObserver {
            override onExternalEvent(
                _source: Participant,
                event: SemanticEvent<unknown>,
            ): void {
                if (PlanningStreamCompleted.is(event)) completed.push(event.data)
            }
        })()
        feed.join(env)
        board.join(env)
        watcher.join(env)

        const result = await runPlannerBusSession({
            runId: "run-native-planner",
            cwd: process.cwd(),
            env,
            feed,
            goalEnvelope: GOAL_ENVELOPE,
            prdMetadata: {
                project: "health",
                branchName: "baro/health",
                description: "Add a health endpoint",
            },
            backend: "fake-native-planner",
            idleTimeoutMs: 20_000,
        })

        assert.equal(result.status, "completed", result.reason)
        assert.deepEqual(board.proposed, ["F1"])
        // The receipt is the whole point of publishing early: the planner must
        // see the host's admission before it plans anything after it.
        const seen = lane.planner!.receipts.join(" ")
        assert.match(seen, /graphVersion/u)
        assert.match(seen, /admittedStoryIds/u)
        assert.match(seen, /S1/u)
        // The host composes the final plan from what it admitted, not from
        // what the model restated.
        const final = (completed[0] as { finalPrd: { userStories: unknown[] } })
            .finalPrd
        assert.equal(final.userStories.length, 1)
    })
})
