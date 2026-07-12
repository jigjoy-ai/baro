import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    Coordination,
    CoordinationModeSelected,
    CollaborationNote,
    Critique,
    PeerHelpRequested,
    RunVerificationCompleted,
    RunVerificationRequested,
    RunVerificationTimedOut,
    StoryIntervention,
    WorkClaimed,
    WorkDiscovered,
    WorkLeaseGranted,
    WorkLeaseExpired,
    WorkOffered,
    type CoordinationData,
    type CritiqueData,
    type StoryInterventionData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/**
 * Forwards coordination, critique and intervention notices. Critique and
 * intervention get structured BaroEvents (protocol v2) plus their legacy
 * `story_log` mirrors for one release.
 */
export class CoordinationForwarder extends BaseObserver {
    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (Coordination.is(event)) {
            this.handleCoordination(event.data)
            return
        }
        if (Critique.is(event)) {
            this.handleCritique(event.data)
            return
        }
        if (StoryIntervention.is(event)) {
            this.handleIntervention(event.data)
            return
        }
        if (CoordinationModeSelected.is(event)) {
            emit({
                type: "story_log",
                id: "_run",
                line: `[coordination] ${event.data.mode}`,
            })
            return
        }
        if (RunVerificationRequested.is(event)) {
            emit({
                type: "activity",
                id: "_verify",
                kind: "test",
                text: "Verifying the fully integrated run",
            })
            emit({
                type: "story_log",
                id: "_verify",
                line: `[verify] started (${event.data.verificationId})`,
            })
            return
        }
        if (RunVerificationCompleted.is(event)) {
            const commands = event.data.commands
                .map((command) => `${command.command}: ${command.status}`)
                .join(", ")
            emit({
                type: "activity",
                id: "_verify",
                kind: "test",
                text: `Run verification ${event.data.status}${commands ? ` — ${commands}` : ""}`,
                ...(event.data.status === "skipped"
                    ? {}
                    : { ok: event.data.status === "passed" }),
            })
            emit({
                type: "story_log",
                id: "_verify",
                line: `[verify/${event.data.status}] ${commands || "no build/test command detected"}`,
            })
            return
        }
        if (RunVerificationTimedOut.is(event)) {
            emit({
                type: "activity",
                id: "_verify",
                kind: "test",
                text: `Run verification timed out after ${Math.ceil(event.data.timeoutMs / 1_000)}s`,
                ok: false,
            })
            return
        }
        if (WorkOffered.is(event)) {
            emit({
                type: "story_log",
                id: event.data.request.storyId,
                line: `[collective] work offered (${event.data.offerId})`,
            })
            return
        }
        if (WorkClaimed.is(event)) {
            emit({
                type: "story_log",
                id: event.data.storyId,
                line: `[collective] claimed by ${event.data.workerId} → ${event.data.backend}:${event.data.model}`,
            })
            return
        }
        if (WorkLeaseGranted.is(event)) {
            emit({
                type: "story_log",
                id: event.data.request.storyId,
                line: `[collective] lease granted to ${event.data.workerId}`,
            })
            return
        }
        if (WorkLeaseExpired.is(event)) {
            emit({
                type: "story_log",
                id: event.data.storyId,
                line: `[collective] lease expired: ${event.data.reason}`,
            })
            return
        }
        if (PeerHelpRequested.is(event)) {
            emit({
                type: "story_log",
                id: event.data.sourceAgentId,
                line: `[peer/help] ${event.data.text}`,
            })
            return
        }
        if (CollaborationNote.is(event)) {
            emit({
                type: "story_log",
                id: event.data.sourceAgentId,
                line: `[peer/note] ${event.data.text}`,
            })
            return
        }
        if (WorkDiscovered.is(event)) {
            emit({
                type: "story_log",
                id: event.data.sourceAgentId,
                line: `[peer/discovered] ${event.data.story.id}: ${event.data.reason}`,
            })
            return
        }
    }

    private handleIntervention(item: StoryInterventionData): void {
        emit({
            type: "intervention",
            id: item.storyId,
            source: item.source,
            action: item.action,
            reason: item.reason,
        })
        emit({
            type: "story_log",
            id: item.storyId,
            line: `⚠ [${item.source}/${item.action}] ${item.reason} — aborting so it can be split/escalated`,
        })
        emit({
            type: "activity",
            id: item.storyId,
            kind: "warn",
            text: `Supervisor paused ${item.storyId}: ${item.reason}. It will be retried or replanned.`,
        })
    }

    private handleCoordination(item: CoordinationData): void {
        emit({
            type: "story_log",
            id: item.recipientId,
            line: `[sentry/${item.kind}] ${item.reason}`,
        })
    }

    private handleCritique(item: CritiqueData): void {
        emit({
            type: "critique",
            id: item.agentId,
            verdict: item.verdict,
            reasoning: item.reasoning,
            violated: [...item.violatedCriteria],
        })
        emit({
            type: "story_log",
            id: item.agentId,
            line: `[critic/${item.verdict}] ${item.reasoning}`,
        })
    }
}
