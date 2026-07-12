import { BaseObserver, Participant, SemanticEvent } from "@mozaik-ai/core"

import {
    ConductorState,
    Critique,
    Replan,
    RuntimeReplanApplied,
    RuntimeReplanRejected,
    type ConductorStateData,
    type CritiqueData,
    type ReplanData,
    type RuntimeReplanAppliedData,
    type RuntimeReplanRejectedData,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

/**
 * Mirrors Conductor lifecycle as a `progress` BaroEvent — the Rust TUI
 * doesn't understand `conductor_state` directly.
 */
export class ProgressForwarder extends BaseObserver {
    private runtimeReplanAuthority: Participant | null = null
    private readonly seenRuntimeDecisions = new Set<string>()

    setRuntimeReplanAuthority(authority: Participant): void {
        if (
            this.runtimeReplanAuthority &&
            this.runtimeReplanAuthority !== authority
        ) {
            throw new Error(
                "Progress forwarder runtime replan authority is already bound",
            )
        }
        this.runtimeReplanAuthority = authority
    }

    override async onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (ConductorState.is(event)) {
            this.handleConductorState(event.data)
            return
        }
        if (Replan.is(event)) {
            // A raw collective Replan is only a proposal. Wait for the
            // Board's authoritative applied/rejected decision before telling
            // the operator that the graph changed.
            if (this.runtimeReplanAuthority) return
            this.handleReplan(event.data)
            return
        }
        if (RuntimeReplanApplied.is(event)) {
            if (
                source !== this.runtimeReplanAuthority ||
                this.seenRuntimeDecisions.has(event.data.proposalId) ||
                (event.data.currentGraphVersion !== undefined &&
                    event.data.graphVersion < event.data.currentGraphVersion)
            ) return
            this.seenRuntimeDecisions.add(event.data.proposalId)
            this.handleRuntimeReplanApplied(event.data)
            return
        }
        if (RuntimeReplanRejected.is(event)) {
            if (
                source !== this.runtimeReplanAuthority ||
                this.seenRuntimeDecisions.has(event.data.proposalId)
            ) return
            this.seenRuntimeDecisions.add(event.data.proposalId)
            this.handleRuntimeReplanRejected(event.data)
            return
        }
        if (Critique.is(event)) {
            this.handleCritique(event.data)
            return
        }
    }

    private handleConductorState(item: ConductorStateData): void {
        if (
            item.phase === "running_level" &&
            item.currentLevel != null &&
            item.totalLevels != null
        ) {
            emit({
                type: "progress",
                completed: item.currentLevel - 1,
                total: item.totalLevels,
                percentage: Math.round(
                    ((item.currentLevel - 1) / Math.max(1, item.totalLevels)) * 100,
                ),
            })
        }
        if (item.detail) {
            emit({
                type: "activity",
                id: "plan",
                kind: item.phase === "failed" ? "error" : "warn",
                text: item.detail,
            })
        }
    }

    private handleReplan(item: ReplanData): void {
        const added = item.addedStories.length
        const removed = item.removedStoryIds.length
        emit({
            type: "activity",
            id: "plan",
            kind: "warn",
            text: `Replanned (${item.source}): +${added}/-${removed} — ${item.reason}`,
        })
    }

    private handleRuntimeReplanApplied(item: RuntimeReplanAppliedData): void {
        const added = item.mutation.addedStories.length
        const removed = item.mutation.removedStoryIds.length
        emit({
            type: "activity",
            id: "plan",
            kind: "warn",
            text: `Replanned (agent:${item.sourceStoryId}@graph-v${item.graphVersion}): +${added}/-${removed} — ${item.reason}`,
        })
    }

    private handleRuntimeReplanRejected(item: RuntimeReplanRejectedData): void {
        emit({
            type: "activity",
            id: "plan",
            kind: "warn",
            text: `Replan rejected (agent:${item.sourceStoryId}, ${item.code}): ${item.reason}`,
        })
    }

    private handleCritique(item: CritiqueData): void {
        emit({
            type: "activity",
            id: item.agentId,
            kind: "verdict",
            ok: item.verdict === "pass",
            text:
                item.verdict === "pass"
                    ? `Critic accepted ${item.agentId}`
                    : `Critic rejected ${item.agentId}: ${item.reasoning}`,
        })
    }
}
