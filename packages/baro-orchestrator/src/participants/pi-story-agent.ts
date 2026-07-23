/**
 * PiStoryAgent — drives a PiCliParticipant through one story.
 * `pi` is one-shot (fresh process per attempt); the shared retry, review,
 * suspension, and quiescence lifecycle lives in OneShotStoryAgent.
 */

import { PiSystem, PiUnknownEvent } from "../semantic-events.js"
import { isCliFailureSignal } from "./cli-story-failure.js"
import {
    PiCliParticipant,
    type PiRunSummary,
} from "./pi-cli-participant.js"
import {
    OneShotStoryAgent,
    type OneShotStoryCoreSpec,
    type OneShotStoryOutcome,
} from "./one-shot-story-agent.js"
import { correlationOf } from "./story-agent.js"

export interface PiStorySpec extends OneShotStoryCoreSpec {
    /** Provider override; omit to use Pi's configured default ("google"). */
    provider?: string
    /** Model override, passed through as an opaque string. */
    model?: string
    piBin?: string
}

export type PiStoryOutcome = OneShotStoryOutcome<PiRunSummary>

export class PiStoryAgent extends OneShotStoryAgent<PiRunSummary> {
    constructor(spec: PiStorySpec) {
        super(spec, {
            name: "pi",
            createRunner: (prompt) =>
                new PiCliParticipant(spec.id, {
                    cwd: spec.cwd,
                    prompt,
                    provider: spec.provider,
                    model: spec.model,
                    piBin: spec.piBin,
                    targetedMessageAuthority: spec.targetedMessageAuthority,
                    targetedMessageCorrelation: correlationOf(spec),
                }),
            failureSignalFrom: (event) => {
                if (
                    PiUnknownEvent.is(event) &&
                    isCliFailureSignal(event.data.raw, event.data.piType)
                ) {
                    return event.data.raw
                }
                if (
                    PiSystem.is(event) &&
                    event.data.subtype === "agent_end" &&
                    isCliFailureSignal(event.data.raw, event.data.subtype)
                ) {
                    return event.data.raw
                }
                return undefined
            },
            // Pi exits 0 even on a refusal or no-op, so success needs
            // positive evidence: the agent loop finished and at least one
            // tool call succeeded — no tools ⇒ prose, not edits.
            positiveEvidenceFailure: (summary) => {
                if (!summary.sawAgentEnd) {
                    return {
                        reason:
                            "pi exited 0 but emitted no agent_end — the agent loop did not complete",
                        failure: { kind: "execution", code: "model_error" },
                    }
                }
                if (summary.toolSuccessCount === 0) {
                    return {
                        reason:
                            summary.toolCallCount === 0
                                ? "pi exited 0 but invoked no tools — answered in prose without editing the worktree"
                                : "pi exited 0 and invoked tools but every tool call failed (isError) — the worktree was not successfully edited",
                        failure: { kind: "execution", code: "no_work_product" },
                    }
                }
                return null
            },
        })
    }

    getCurrentPi(): PiCliParticipant | null {
        return this.getCurrentRunner() as PiCliParticipant | null
    }
}
