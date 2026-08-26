/**
 * Mid-run per-story status persistence for prd.json.
 *
 * TypeScript is the single transactional owner of story status while a run
 * executes: Rust only rewrites prd.json BEFORE spawning the orchestrator, so
 * one load-modify-savePrdAtomic writer here needs no lock. Without this the
 * on-disk PRD only learned about merges at run end, and an interrupted run
 * re-executed work that had already landed.
 */

import { BaseObserver, type Participant, type SemanticEvent } from "../runtime/mozaik.js"

import { loadPrd, savePrdAtomic, type PrdFile } from "../prd.js"
import { StoryMergeFailed, StoryMerged } from "../semantic-events.js"

export interface PrdStatusWriterOptions {
    prdPath: string
    load?: (path: string) => PrdFile
    save?: (path: string, prd: PrdFile) => void
    warn?: (line: string) => void
}

export interface PrdStatusWriter {
    onStoryMerged(storyId: string, mergeCommitSha?: string): void
    onStoryFailed(storyId: string): void
}

export function createPrdStatusWriter({
    prdPath,
    load = loadPrd,
    save = savePrdAtomic,
    warn = (line) => process.stderr.write(`${line}\n`),
}: PrdStatusWriterOptions): PrdStatusWriter {
    // One warning per story, not per event: a PRD we cannot write is a
    // condition, and repeating it once per story keeps the run readable.
    const warnedUnknown = new Set<string>()
    const warnedWriteFailure = new Set<string>()

    const apply = (
        storyId: string,
        mutate: (story: PrdFile["userStories"][number]) => PrdFile["userStories"][number],
    ): void => {
        try {
            const prd = load(prdPath)
            if (!prd.userStories.some((story) => story.id === storyId)) {
                if (!warnedUnknown.has(storyId)) {
                    warnedUnknown.add(storyId)
                    warn(
                        `[prd-status] no story '${storyId}' in ${prdPath}; status not recorded`,
                    )
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
            warn(
                `[prd-status] could not record '${storyId}' in ${prdPath}: ${(error as Error)?.message ?? String(error)}`,
            )
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
 * Bus adapter: turns the repository authority's StoryMerged / StoryMergeFailed
 * into writer calls. Only the bound repository authority is trusted, so an
 * ambient participant cannot rewrite story status.
 */
export class PrdStatusObserver extends BaseObserver {
    private repositoryAuthority: Participant | null = null

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
        if (!this.repositoryAuthority || source !== this.repositoryAuthority) {
            return
        }
        if (StoryMerged.is(event)) {
            this.writer.onStoryMerged(
                event.data.storyId,
                event.data.mergeCommitSha,
            )
            return
        }
        if (StoryMergeFailed.is(event)) {
            this.writer.onStoryFailed(event.data.storyId)
        }
    }
}
