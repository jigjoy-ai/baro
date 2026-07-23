/**
 * OpenCodeStoryAgent — drives an OpenCodeCliParticipant through one story.
 * `opencode run` is one-shot (fresh process per attempt); the shared retry,
 * review, suspension, and quiescence lifecycle lives in OneShotStoryAgent.
 */

import { OpenCodeUnknownEvent } from "../semantic-events.js"
import { isCliFailureSignal } from "./cli-story-failure.js"
import {
    OpenCodeCliParticipant,
    type OpenCodeRunSummary,
} from "./opencode-cli-participant.js"
import {
    OneShotStoryAgent,
    type OneShotStoryCoreSpec,
    type OneShotStoryOutcome,
} from "./one-shot-story-agent.js"
import { correlationOf } from "./story-agent.js"

export interface OpenCodeStorySpec extends OneShotStoryCoreSpec {
    /** Provider-qualified model, e.g. "anthropic/claude-sonnet-4-20250514". */
    model?: string
    opencodeBin?: string
    /**
     * Pass `--dangerously-skip-permissions`. Required for autonomous baro
     * runs — OpenCode's default mode prompts for tool approvals.
     */
    skipPermissions?: boolean
}

export type OpenCodeStoryOutcome = OneShotStoryOutcome<OpenCodeRunSummary>

export class OpenCodeStoryAgent extends OneShotStoryAgent<OpenCodeRunSummary> {
    constructor(spec: OpenCodeStorySpec) {
        super(spec, {
            name: "opencode",
            createRunner: (prompt) =>
                new OpenCodeCliParticipant(spec.id, {
                    cwd: spec.cwd,
                    prompt,
                    model: spec.model,
                    opencodeBin: spec.opencodeBin,
                    skipPermissions: spec.skipPermissions ?? true,
                    targetedMessageAuthority: spec.targetedMessageAuthority,
                    targetedMessageCorrelation: correlationOf(spec),
                }),
            failureSignalFrom: (event) =>
                OpenCodeUnknownEvent.is(event) &&
                isCliFailureSignal(event.data.raw, event.data.openCodeType)
                    ? event.data.raw
                    : undefined,
            // `opencode run` exits 0 even on a refusal or no-op (verified
            // empirically), so success needs positive evidence: the agent
            // loop finished and at least one tool was invoked — no tools ⇒
            // it answered in prose, not edits.
            positiveEvidenceFailure: (summary) => {
                if (!summary.sawStepFinish) {
                    return {
                        reason:
                            "opencode exited 0 but emitted no step_finish — the agent loop did not complete (likely a refusal or early abort)",
                        failure: { kind: "execution", code: "model_error" },
                    }
                }
                if (summary.toolCallCount === 0) {
                    return {
                        reason:
                            "opencode exited 0 but invoked no tools — the agent answered in prose without editing the worktree, so the story is not verifiably done",
                        failure: { kind: "execution", code: "no_work_product" },
                    }
                }
                return null
            },
        })
    }

    getCurrentOpenCode(): OpenCodeCliParticipant | null {
        return this.getCurrentRunner() as OpenCodeCliParticipant | null
    }
}
