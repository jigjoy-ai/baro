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
import type { BaroEvent } from "../../src/tui-protocol.js"

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

function emptyPrd(): PrdFile {
    return {
        project: "p",
        branchName: "b",
        description: "d",
        userStories: [story("S1")],
    } as PrdFile
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

    it("says so once, in the run stream, when the event names a story the PRD does not have", () => {
        const path = prdFileWith("S1")
        const activity: BaroEvent[] = []
        const writer = createPrdStatusWriter({
            prdPath: path,
            emitActivity: (event) => activity.push(event),
        })
        const before = readFileSync(path, "utf8")

        writer.onStoryMerged("ghost", "abc123")
        writer.onStoryFailed("ghost")

        assert.equal(readFileSync(path, "utf8"), before, "unknown id is a no-op")
        assert.equal(activity.length, 1, "one report per story, not per event")
        assert.deepEqual(activity[0], {
            type: "activity",
            id: "ghost",
            kind: "warn",
            text: `[prd-status] no story 'ghost' in ${path}; status not recorded`,
            ok: false,
        })
    })

    it("stays silent when the run has no prd.json on disk at all", () => {
        const activity: BaroEvent[] = []
        let loaded = 0
        let saved = 0
        const writer = createPrdStatusWriter({
            prdPath: join(mkdtempSync(join(tmpdir(), "prd-status-")), "prd.json"),
            load: () => {
                loaded += 1
                return emptyPrd()
            },
            save: () => {
                saved += 1
            },
            emitActivity: (event) => activity.push(event),
        })

        writer.onStoryMerged("S1", "abc123")
        writer.onStoryFailed("S1")

        assert.deepEqual(activity, [], "a PRD-less run is not a failure")
        assert.equal(loaded, 0)
        assert.equal(saved, 0)
    })

    it("never throws a save failure back into the event bus", () => {
        const path = prdFileWith("S1")
        const activity: BaroEvent[] = []
        const writer = createPrdStatusWriter({
            prdPath: path,
            save: () => {
                throw new Error("disk is full")
            },
            emitActivity: (event) => activity.push(event),
        })

        assert.doesNotThrow(() => writer.onStoryMerged("S1", "abc123"))
        assert.doesNotThrow(() => writer.onStoryFailed("S1"))

        assert.equal(activity.length, 1, "one report per story, not per event")
        assert.deepEqual(activity[0], {
            type: "activity",
            id: "S1",
            kind: "error",
            text: `[prd-status] could not record 'S1' in ${path}: disk is full`,
            ok: false,
        })
    })

    it("never throws a load failure back into the event bus", () => {
        const path = prdFileWith("S1")
        const activity: BaroEvent[] = []
        const writer = createPrdStatusWriter({
            prdPath: path,
            load: () => {
                throw new Error("prd.json is not JSON")
            },
            emitActivity: (event) => activity.push(event),
        })

        assert.doesNotThrow(() => writer.onStoryMerged("S1", "abc123"))

        assert.equal(activity.length, 1)
        assert.deepEqual(activity[0], {
            type: "activity",
            id: "S1",
            kind: "error",
            text: `[prd-status] could not record 'S1' in ${path}: prd.json is not JSON`,
            ok: false,
        })
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

    it("accepts a merge from any source when the run has no repository authority", () => {
        const path = prdFileWith("S1", "S2")
        const observer = new PrdStatusObserver(
            createPrdStatusWriter({ prdPath: path }),
        )

        // A legacy non-git run: nothing ever calls setRepositoryAuthority.
        observer.onExternalEvent(
            new FakeRepository(),
            StoryMerged.create({
                storyId: "S1",
                mode: "shared-tree",
                mergeCommitSha: "abc1234",
            }),
        )

        assert.equal(storyOnDisk(path, "S1").mergeStatus, "merged")
        assert.equal(storyOnDisk(path, "S1").mergeCommitSha, "abc1234")
        assert.equal(storyOnDisk(path, "S2").mergeStatus, undefined)
    })

    it("writes a relayed outcome once, and still lets a later merge overwrite the failure", () => {
        let writes = 0
        const observer = new PrdStatusObserver({
            onStoryMerged(storyId, mergeCommitSha) {
                writes += 1
                assert.equal(storyId, "S1")
                assert.equal(mergeCommitSha, "abc1234")
            },
            onStoryFailed(storyId) {
                writes += 1
                assert.equal(storyId, "S1")
            },
        })
        const failure = StoryMergeFailed.create({
            storyId: "S1",
            error: "conflict",
        })

        observer.onExternalEvent(new FakeRepository(), failure)
        // A forwarder re-emits the very same outcome.
        observer.onExternalEvent(new FakeRepository(), failure)
        assert.equal(writes, 1, "a relayed copy is not a second outcome")

        observer.onExternalEvent(
            new FakeRepository(),
            StoryMerged.create({
                storyId: "S1",
                mode: "shared-tree",
                mergeCommitSha: "abc1234",
            }),
        )
        assert.equal(writes, 2, "merged and failed are distinct outcomes")
    })

    it("persists a relayed failure to disk exactly once", () => {
        const path = prdFileWith("S1")
        const observer = new PrdStatusObserver(
            createPrdStatusWriter({ prdPath: path }),
        )
        const failure = StoryMergeFailed.create({
            storyId: "S1",
            error: "conflict",
        })

        observer.onExternalEvent(new FakeRepository(), failure)
        assert.equal(storyOnDisk(path, "S1").mergeStatus, "failed")

        observer.onExternalEvent(new FakeRepository(), failure)
        assert.equal(storyOnDisk(path, "S1").mergeStatus, "failed")

        observer.onExternalEvent(
            new FakeRepository(),
            StoryMerged.create({
                storyId: "S1",
                mode: "shared-tree",
                mergeCommitSha: "abc1234",
            }),
        )
        assert.equal(storyOnDisk(path, "S1").mergeStatus, "merged")
        assert.equal(storyOnDisk(path, "S1").mergeCommitSha, "abc1234")
    })
})
