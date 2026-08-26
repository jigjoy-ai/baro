import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { BaseObserver } from "../../src/runtime/mozaik.js"
import { StoryMergeFailed, StoryMerged } from "../../src/semantic-events.js"
import {
    PrdStatusObserver,
    createPrdStatusWriter,
} from "../../src/execution/prd-status-writer.js"
import { loadPrd, type PrdFile } from "../../src/prd.js"

const temporaryRoots: string[] = []

after(() => {
    for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

function story(id: string) {
    return {
        id,
        priority: 0,
        title: id,
        description: "",
        dependsOn: [],
        retries: 1,
        acceptance: [],
        tests: [],
        passes: false,
        completedAt: null,
        durationSecs: null,
    }
}

function prdFileWith(...ids: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "prd-status-"))
    temporaryRoots.push(root)
    const path = join(root, "prd.json")
    writeFileSync(
        path,
        JSON.stringify(
            {
                project: "p",
                branchName: "baro/p",
                description: "d",
                userStories: ids.map(story),
            },
            null,
            2,
        ),
    )
    return path
}

function storyOnDisk(path: string, id: string) {
    return loadPrd(path).userStories.find((s) => s.id === id)!
}

class FakeRepository extends BaseObserver {}

describe("what prd.json knows while the run is still going", () => {
    it("records a merge the moment it lands, not at run end", () => {
        const path = prdFileWith("S1", "S2")
        const writer = createPrdStatusWriter({ prdPath: path })

        writer.onStoryMerged("S1", "abc123")

        const merged = storyOnDisk(path, "S1")
        assert.equal(merged.passes, true)
        assert.equal(merged.mergeStatus, "merged")
        assert.equal(merged.mergeCommitSha, "abc123")
        assert.ok(
            merged.completedAt && !Number.isNaN(Date.parse(merged.completedAt)),
            "completedAt must be an ISO timestamp",
        )
        // The other story is untouched — one merge is not a run outcome.
        assert.equal(storyOnDisk(path, "S2").passes, false)
        assert.equal(storyOnDisk(path, "S2").mergeStatus, undefined)
    })

    it("omits the merge sha when the run could not read one", () => {
        const path = prdFileWith("S1")
        createPrdStatusWriter({ prdPath: path }).onStoryMerged("S1")

        const merged = storyOnDisk(path, "S1")
        assert.equal(merged.mergeStatus, "merged")
        assert.equal(merged.mergeCommitSha, undefined)
    })

    it("marks a failure without retracting a story that already passed", () => {
        const path = prdFileWith("S1")
        const writer = createPrdStatusWriter({ prdPath: path })

        writer.onStoryMerged("S1", "abc123")
        writer.onStoryFailed("S1")

        const settled = storyOnDisk(path, "S1")
        assert.equal(settled.mergeStatus, "failed")
        assert.equal(settled.passes, true, "passes is not the writer's to clear")
    })

    it("records a terminal failure on a story that never landed", () => {
        const path = prdFileWith("S1")
        createPrdStatusWriter({ prdPath: path }).onStoryFailed("S1")

        const failed = storyOnDisk(path, "S1")
        assert.equal(failed.mergeStatus, "failed")
        assert.equal(failed.passes, false)
        assert.equal(failed.completedAt, null)
    })

    it("keeps every earlier story's status when the next one settles", () => {
        const path = prdFileWith("S1", "S2")
        const writer = createPrdStatusWriter({ prdPath: path })

        writer.onStoryMerged("S1", "sha-1")
        writer.onStoryFailed("S2")

        assert.equal(storyOnDisk(path, "S1").mergeStatus, "merged")
        assert.equal(storyOnDisk(path, "S1").mergeCommitSha, "sha-1")
        assert.equal(storyOnDisk(path, "S2").mergeStatus, "failed")
    })

    it("re-reads the PRD each time so a concurrent edit is not clobbered", () => {
        const path = prdFileWith("S1", "S2")
        const writer = createPrdStatusWriter({ prdPath: path })

        writer.onStoryMerged("S1", "sha-1")
        // Something else (the Board, a replan) rewrites the file mid-run.
        const between = loadPrd(path)
        between.description = "rewritten between events"
        writeFileSync(path, JSON.stringify(between, null, 2))

        writer.onStoryMerged("S2", "sha-2")

        const final = loadPrd(path)
        assert.equal(final.description, "rewritten between events")
        assert.equal(final.userStories[0]!.mergeCommitSha, "sha-1")
        assert.equal(final.userStories[1]!.mergeCommitSha, "sha-2")
    })

    it("says so once when the event names a story the PRD does not have", () => {
        const path = prdFileWith("S1")
        const warnings: string[] = []
        const writer = createPrdStatusWriter({
            prdPath: path,
            warn: (line) => warnings.push(line),
        })
        const before = readFileSync(path, "utf8")

        writer.onStoryMerged("ghost", "abc123")
        writer.onStoryFailed("ghost")

        assert.equal(readFileSync(path, "utf8"), before, "unknown id is a no-op")
        assert.equal(warnings.length, 1)
        assert.match(warnings[0]!, /ghost/)
    })

    it("never throws a write failure back into the event bus", () => {
        const warnings: string[] = []
        const writer = createPrdStatusWriter({
            prdPath: "/nowhere/prd.json",
            load: () =>
                ({
                    project: "p",
                    branchName: "b",
                    description: "d",
                    userStories: [story("S1")],
                }) as PrdFile,
            save: () => {
                throw new Error("disk is full")
            },
            warn: (line) => warnings.push(line),
        })

        assert.doesNotThrow(() => writer.onStoryMerged("S1", "abc123"))
        assert.doesNotThrow(() => writer.onStoryFailed("S1"))

        assert.equal(warnings.length, 1, "one warning per story, not per event")
        assert.match(warnings[0]!, /disk is full/)
    })
})

describe("which bus events may rewrite story status", () => {
    it("persists StoryMerged and StoryMergeFailed from the repository authority", () => {
        const path = prdFileWith("S1", "S2")
        const observer = new PrdStatusObserver(
            createPrdStatusWriter({ prdPath: path }),
        )
        const repository = new FakeRepository()
        observer.setRepositoryAuthority(repository)

        observer.onExternalEvent(
            repository,
            StoryMerged.create({
                storyId: "S1",
                mode: "worktree",
                mergeCommitSha: "abc123",
            }),
        )
        observer.onExternalEvent(
            repository,
            StoryMergeFailed.create({ storyId: "S2", error: "conflict" }),
        )

        assert.equal(storyOnDisk(path, "S1").mergeStatus, "merged")
        assert.equal(storyOnDisk(path, "S1").mergeCommitSha, "abc123")
        assert.equal(storyOnDisk(path, "S2").mergeStatus, "failed")
    })

    it("ignores the same events from a participant that is not the authority", () => {
        const path = prdFileWith("S1")
        const observer = new PrdStatusObserver(
            createPrdStatusWriter({ prdPath: path }),
        )
        observer.setRepositoryAuthority(new FakeRepository())

        observer.onExternalEvent(
            new FakeRepository(),
            StoryMerged.create({ storyId: "S1", mode: "worktree" }),
        )

        assert.equal(storyOnDisk(path, "S1").mergeStatus, undefined)
        assert.equal(storyOnDisk(path, "S1").passes, false)
    })
})
