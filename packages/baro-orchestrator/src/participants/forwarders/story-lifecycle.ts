import {
    BaseObserver,
    FunctionCallItem,
    Participant,
    SemanticEvent,
} from "@mozaik-ai/core"

import {
    AgentState,
    type AgentStateData,
    StoryResult,
    type StoryResultData,
    StorySpawnRequest,
} from "../../semantic-events.js"
import { emit } from "../../tui-protocol.js"

// Write-ish tools across all backends. "create" = a whole-file write
// (Claude `Write`, story-tools `write_file`); "edit" = an in-place edit
// (which implies the file pre-existed).
const CREATE_TOOLS = new Set(["Write", "write_file"])
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "edit_file"])

/**
 * Mirrors story lifecycle transitions as BaroEvents consumed by the Rust TUI.
 *
 * Subscribes to: AgentState, StoryResult, and per-agent function calls.
 * Emits: story_start, story_complete, story_error, story_retry.
 */
export class StoryLifecycleForwarder extends BaseObserver {
    private startedStories = new Set<string>()
    private retryCounts = new Map<string, number>()
    /** storyId → retry budget from its spawn request, so story_error reports the real max. */
    private retryBudget = new Map<string, number>()
    // storyId → (path → first-touch kind). Distinct paths per story, so a
    // file touched many times counts once, classified by its first write.
    // Reset on each retry so story_complete reflects only the winning
    // attempt's touches, not files a failed attempt wrote and abandoned.
    private filesByStory = new Map<string, Map<string, "created" | "modified">>()

    override async onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): Promise<void> {
        if (AgentState.is(event)) {
            this.handleAgentState(event.data)
            return
        }
        if (StorySpawnRequest.is(event)) {
            this.retryBudget.set(event.data.storyId, event.data.retries)
            return
        }
        if (StoryResult.is(event)) {
            this.handleStoryResult(event.data)
            return
        }
    }

    // Same signal the Sentry uses: a write/edit tool call from a story
    // agent. We attribute the touched path to that agent's story and
    // remember its first-touch kind so story_complete can report real
    // per-story file counts instead of a hardcoded 0.
    override async onExternalFunctionCall(
        source: Participant,
        item: FunctionCallItem,
    ): Promise<void> {
        const isCreate = CREATE_TOOLS.has(item.name)
        const isEdit = EDIT_TOOLS.has(item.name)
        if (!isCreate && !isEdit) return
        const agentId = (source as unknown as { agentId?: string }).agentId
        if (typeof agentId !== "string") return
        const path = extractPath(item)
        if (!path) return

        let paths = this.filesByStory.get(agentId)
        if (!paths) {
            paths = new Map()
            this.filesByStory.set(agentId, paths)
        }
        // Keep the FIRST touch's classification; a later edit of a file we
        // saw created stays "created".
        if (!paths.has(path)) {
            paths.set(path, isCreate ? "created" : "modified")
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
            // Drop the failed attempt's file touches so the eventual
            // story_complete counts only the attempt that actually lands.
            this.filesByStory.delete(item.agentId)
            emit({ type: "story_retry", id: item.agentId, attempt: count })
        }
    }

    private handleStoryResult(item: StoryResultData): void {
        if (item.success) {
            const paths = this.filesByStory.get(item.storyId)
            let created = 0
            let modified = 0
            if (paths) {
                for (const kind of paths.values()) {
                    if (kind === "created") created++
                    else modified++
                }
            }
            this.filesByStory.delete(item.storyId)
            emit({
                type: "story_complete",
                id: item.storyId,
                duration_secs: item.durationSecs,
                files_created: created,
                files_modified: modified,
            })
        } else {
            this.filesByStory.delete(item.storyId)
            emit({
                type: "story_error",
                id: item.storyId,
                error: item.error ?? "unknown error",
                attempt: item.attempts,
                max_retries: this.retryBudget.get(item.storyId) ?? item.attempts,
            })
        }
    }
}

/** Pull the file path out of a write/edit tool call's JSON args. */
function extractPath(item: FunctionCallItem): string | null {
    let args: Record<string, unknown>
    try {
        args = JSON.parse(item.args) as Record<string, unknown>
    } catch {
        return null
    }
    for (const key of ["file_path", "path", "notebook_path"]) {
        const v = args[key]
        if (typeof v === "string") return v
    }
    return null
}
