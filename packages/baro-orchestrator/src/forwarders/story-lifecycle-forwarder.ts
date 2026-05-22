import {
    BaseObserver,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    AgentState,
    StoryResult,
    type AgentStateData,
    type StoryResultData,
} from "../semantic-events.js"
import { emit } from "../tui-protocol.js"

export class StoryLifecycleForwarder extends BaseObserver {
    private startedStories = new Set<string>()
    private retryCounts = new Map<string, number>()

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (AgentState.is(event)) {
            this.handleAgentState(event.data)
            return
        }
        if (StoryResult.is(event)) {
            this.handleStoryResult(event.data)
            return
        }
    }

    private handleAgentState(item: AgentStateData): void {
        if (item.phase === "running" && !this.startedStories.has(item.agentId)) {
            this.startedStories.add(item.agentId)
            emit({ type: "story_start", id: item.agentId, title: item.agentId })
        }
        if (item.phase === "waiting" && item.detail?.includes("retrying")) {
            const count = (this.retryCounts.get(item.agentId) ?? 0) + 1
            this.retryCounts.set(item.agentId, count)
            emit({ type: "story_retry", id: item.agentId, attempt: count })
        }
    }

    private handleStoryResult(item: StoryResultData): void {
        if (item.success) {
            emit({
                type: "story_complete",
                id: item.storyId,
                duration_secs: item.durationSecs,
                files_created: 0,
                files_modified: 0,
            })
        } else {
            emit({
                type: "story_error",
                id: item.storyId,
                error: item.error ?? "unknown error",
                attempt: item.attempts,
                max_retries: item.attempts,
            })
        }
    }
}
