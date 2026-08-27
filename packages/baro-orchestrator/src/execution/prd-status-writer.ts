/**
 * Mid-run per-story status persistence for prd.json.
 *
 * TypeScript is the single transactional owner of story status while a run
 * executes: Rust only rewrites prd.json BEFORE spawning the orchestrator, so
 * one load-modify-savePrdAtomic writer here needs no lock. Without this the
 * on-disk PRD only learned about merges at run end, and an interrupted run
 * re-executed work that had already landed.
 */

import { existsSync } from "node:fs"

import { BaseObserver, type Participant, type SemanticEvent } from "../runtime/mozaik.js"

import { loadPrd, savePrdAtomic, type PrdFile } from "../prd.js"
import { StoryMergeFailed, StoryMerged } from "../semantic-events.js"
import { emit, type BaroEvent } from "../tui-protocol.js"

export interface PrdStatusWriterOptions {
    prdPath: string
    load?: (path: string) => PrdFile
    save?: (path: string, prd: PrdFile) => void
    emitActivity?: (event: BaroEvent) => void
}

export interface PrdStatusWriter {
    onStoryMerged(storyId: string, mergeCommitSha?: string): void
    onStoryFailed(storyId: string): void
}

export function createPrdStatusWriter({
    prdPath,
    load = loadPrd,
    save = savePrdAtomic,
    emitActivity = emit,
}: PrdStatusWriterOptions): PrdStatusWriter {
    // One report per story, not per event: a PRD we cannot write is a
    // condition, and repeating it once per story keeps the run readable.
    const warnedUnknown = new Set<string>()
    const warnedWriteFailure = new Set<string>()

    const apply = (
        storyId: string,
        mutate: (story: PrdFile["userStories"][number]) => PrdFile["userStories"][number],
    ): void => {
        // A run with no PRD on disk is legitimate (programmatic orchestration,
        // tests); there is nothing to project onto and nothing to report.
        if (!existsSync(prdPath)) return
        try {
            const prd = load(prdPath)
            if (!prd.userStories.some((story) => story.id === storyId)) {
                if (!warnedUnknown.has(storyId)) {
                    warnedUnknown.add(storyId)
                    emitActivity({
                        type: "activity",
                        id: storyId,
                        kind: "warn",
                        text: `[prd-status] no story '${storyId}' in ${prdPath}; status not recorded`,
                        ok: false,
                    })
                }
                return
            }
            save(prdPath, {
                ...prd,
                userStories: prd.userStories.map((story) =>
                    story.id === storyId ? mutate(story) : story,
                ),
            })
        } catch (error) {
            // A status write must never propagate into the event bus: the run
            // is still correct, only its on-disk projection is stale.
            if (warnedWriteFailure.has(storyId)) return
            warnedWriteFailure.add(storyId)
            const message = error instanceof Error ? error.message : String(error)
            emitActivity({
                type: "activity",
                id: storyId,
                kind: "error",
                text: `[prd-status] could not record '${storyId}' in ${prdPath}: ${message}`,
                ok: false,
            })
        }
    }

    return {
        onStoryMerged(storyId, mergeCommitSha) {
            apply(storyId, (story) => ({
                ...story,
                passes: true,
                completedAt: new Date().toISOString(),
                mergeStatus: "merged",
                ...(mergeCommitSha !== undefined ? { mergeCommitSha } : {}),
            }))
        },
        onStoryFailed(storyId) {
            // `passes` is deliberately untouched: a failed merge-back does not
            // retract a story that had already landed.
            apply(storyId, (story) => ({ ...story, mergeStatus: "failed" }))
        },
    }
}

/**
 * Bus adapter: turns StoryMerged / StoryMergeFailed into writer calls. When a
 * repository authority is bound (git runs, collective runs) only that
 * participant is trusted. A legacy non-git run has no authority at all, and
 * refusing its events is what left prd.json stale across an interrupt — so
 * with no authority bound every source is accepted, deduped per event kind
 * and story so a relayed copy cannot re-run the write.
 */
export class PrdStatusObserver extends BaseObserver {
    private repositoryAuthority: Participant | null = null
    private readonly settled = new Set<string>()

    constructor(private readonly writer: PrdStatusWriter) {
        super()
    }

    setRepositoryAuthority(authority: Participant): void {
        this.repositoryAuthority = authority
    }

    override onExternalEvent(
        source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (this.repositoryAuthority && source !== this.repositoryAuthority) {
            return
        }
        if (StoryMerged.is(event)) {
            if (!this.claim(event.type, event.data.storyId)) return
            this.writer.onStoryMerged(
                event.data.storyId,
                event.data.mergeCommitSha,
            )
            return
        }
        if (StoryMergeFailed.is(event)) {
            if (!this.claim(event.type, event.data.storyId)) return
            this.writer.onStoryFailed(event.data.storyId)
        }
    }

    /** Merged and failed keep distinct keys, so a late merge can still
     *  overwrite an earlier failure for the same story. */
    private claim(eventType: string, storyId: string): boolean {
        const key = `${eventType}:${storyId}`
        if (this.settled.has(key)) return false
        this.settled.add(key)
        return true
    }
}
