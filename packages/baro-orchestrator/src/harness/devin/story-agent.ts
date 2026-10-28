/**
 * DevinStoryAgent — drives a DevinCliParticipant through one story. Each
 * attempt is a fresh `devin acp` process; the shared retry, review,
 * suspension, and quiescence lifecycle lives in OneShotStoryAgent.
 */

import { DevinSystem } from "../../semantic-events.js"
import {
    DevinCliParticipant,
    type DevinRunSummary,
} from "./cli-participant.js"
import {
    OneShotStoryAgent,
    type OneShotStoryCoreSpec,
    type OneShotStoryOutcome,
} from "../one-shot/story-agent.js"
import { correlationOf } from "../story-contract.js"

export interface DevinStorySpec extends OneShotStoryCoreSpec {
    model?: string
    devinBin?: string
}

export type DevinStoryOutcome = OneShotStoryOutcome<DevinRunSummary>

export class DevinStoryAgent extends OneShotStoryAgent<DevinRunSummary> {
    constructor(spec: DevinStorySpec) {
        super(spec, {
            name: "devin",
            createRunner: (prompt) =>
                new DevinCliParticipant(spec.id, {
                    cwd: spec.cwd,
                    prompt,
                    model: spec.model,
                    devinBin: spec.devinBin,
                    targetedMessageAuthority: spec.targetedMessageAuthority,
                    targetedMessageCorrelation: correlationOf(spec),
                }),
            failureSignalFrom: (event) =>
                DevinSystem.is(event) && event.data.subtype === "failed"
                    ? event.data.raw
                    : undefined,
            // `devin acp` exits 0 after any turn, so success needs positive
            // evidence: the prompt ended normally and a tool call completed.
            positiveEvidenceFailure: (summary) => {
                if (summary.stopReason !== "end_turn") {
                    return {
                        reason: summary.stopReason === null
                            ? "devin exited without finishing its turn"
                            : `devin ended its turn with ${summary.stopReason}`,
                        failure: { kind: "execution", code: "model_error" },
                    }
                }
                if (summary.toolSuccessCount === 0) {
                    return {
                        reason: summary.toolCallCount === 0
                            ? "devin finished without calling a tool — answered in prose without editing the worktree"
                            : "devin called tools but none completed — the worktree was not successfully edited",
                        failure: { kind: "execution", code: "no_work_product" },
                    }
                }
                return null
            },
        })
    }

    getCurrentDevin(): DevinCliParticipant | null {
        return this.getCurrentRunner() as DevinCliParticipant | null
    }
}
