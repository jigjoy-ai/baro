import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { createPrdStatusWriter } from "../src/execution/prd-status-writer.js"
import {
    persistPrdPreserving,
    type PrdFile,
    type PrdStory,
} from "../src/prd.js"

const temporaryRoots: string[] = []

after(() => {
    for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

function temporaryPath(name = "prd.json"): string {
    const root = mkdtempSync(join(tmpdir(), "prd-preserve-"))
    temporaryRoots.push(root)
    return join(root, name)
}

function story(id: string, extra: Partial<PrdStory> = {}): PrdStory {
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
        ...extra,
    }
}

function prdFile(...stories: PrdStory[]): PrdFile {
    return {
        project: "p",
        branchName: "baro/p",
        description: "d",
        userStories: stories,
    }
}

/**
 * The fixture is written as RAW JSON, never through `savePrd`: `goalFingerprint`
 * is not a `PrdFile` member, so a typed round-trip could not put it on disk.
 */
function writeRaw(path: string, value: unknown): void {
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
}

/** Read-back must also be raw — `loadPrd` strips `goalFingerprint` and would
 *  make every assertion about it vacuously pass. */
function readRaw(path: string): Record<string, any> {
    return JSON.parse(readFileSync(path, "utf8"))
}

function diskStory(path: string, id: string): Record<string, any> {
    const found = readRaw(path).userStories.find((s: any) => s.id === id)
    assert.ok(found, `story ${id} missing from ${path}`)
    return found
}

/** Fixture carrying all three foreign-owned fields. */
function fixtureWithForeignFields(): string {
    const path = temporaryPath()
    writeRaw(path, {
        ...prdFile(
            story("S1", { mergeStatus: "merged", mergeCommitSha: "deadbeef" }),
            story("S2"),
        ),
        goalFingerprint: "abc123",
    })
    return path
}

describe("persistPrdPreserving", () => {
    it("keeps foreign-owned fields a full-file snapshot never knew about", () => {
        const path = fixtureWithForeignFields()

        // The caller's snapshot has no goalFingerprint, no mergeStatus and no
        // mergeCommitSha — exactly what a `loadPrd` round-trip hands a writer.
        persistPrdPreserving(path, prdFile(story("S1"), story("S2")))

        assert.equal(readRaw(path).goalFingerprint, "abc123")
        assert.equal(diskStory(path, "S1").mergeStatus, "merged")
        assert.equal(diskStory(path, "S1").mergeCommitSha, "deadbeef")
    })

    it("lets a declared owner clear the field it owns", () => {
        const path = fixtureWithForeignFields()

        persistPrdPreserving(path, prdFile(story("S1"), story("S2")), {
            owns: ["mergeStatus"],
        })

        // An owner's absent value wins, and the key is omitted rather than
        // written as an explicit null/undefined.
        assert.ok(!("mergeStatus" in diskStory(path, "S1")))
        // Fields the caller did not claim are still preserved.
        assert.equal(readRaw(path).goalFingerprint, "abc123")
        assert.equal(diskStory(path, "S1").mergeCommitSha, "deadbeef")
    })

    it("lets a declared owner write a new value for the field it owns", () => {
        const path = fixtureWithForeignFields()

        persistPrdPreserving(
            path,
            prdFile(story("S1", { mergeStatus: "failed" }), story("S2")),
            { owns: ["mergeStatus"] },
        )

        assert.equal(diskStory(path, "S1").mergeStatus, "failed")
    })

    it("does not re-add stories the caller deleted, nor other top-level keys", () => {
        const path = temporaryPath()
        writeRaw(path, {
            ...prdFile(
                story("S1", { mergeStatus: "merged" }),
                story("S2", { mergeStatus: "failed" }),
            ),
            goalFingerprint: "abc123",
            runtimeGraph: { version: 7 },
        })

        persistPrdPreserving(path, prdFile(story("S1")))

        const disk = readRaw(path)
        assert.deepEqual(
            disk.userStories.map((s: any) => s.id),
            ["S1"],
        )
        // Only goalFingerprint is carried over; a blanket merge would have
        // resurrected the runtimeGraph this caller intentionally dropped.
        assert.equal(disk.goalFingerprint, "abc123")
        assert.ok(!("runtimeGraph" in disk))
    })

    it("falls back to a plain atomic write when the file is missing or corrupt", () => {
        const snapshot = prdFile(story("S1"))
        const expected = JSON.parse(JSON.stringify(snapshot))

        const missing = temporaryPath("absent.json")
        assert.doesNotThrow(() => persistPrdPreserving(missing, snapshot))
        assert.deepEqual(readRaw(missing), expected)

        const corrupt = temporaryPath()
        writeFileSync(corrupt, "not json {{{")
        assert.doesNotThrow(() => persistPrdPreserving(corrupt, snapshot))
        assert.deepEqual(readRaw(corrupt), expected)

        // A JSON document that parses but is not an object merges nothing.
        const notAnObject = temporaryPath()
        writeFileSync(notAnObject, "[1, 2, 3]\n")
        assert.doesNotThrow(() => persistPrdPreserving(notAnObject, snapshot))
        assert.deepEqual(readRaw(notAnObject), expected)
    })
})

describe("persistPrdPreserving interleaved with prd-status-writer", () => {
    /**
     * The snapshot is captured BEFORE the status writer runs, which is what
     * makes the middle write a genuine lost-update candidate.
     */
    function interleave(save?: (path: string, prd: PrdFile) => void) {
        const path = temporaryPath()
        writeRaw(path, {
            ...prdFile(story("S1"), story("S2")),
            goalFingerprint: "abc123",
        })
        const stale = prdFile(story("S1"), story("S2"))
        const writer = () =>
            createPrdStatusWriter({ prdPath: path, save, emitActivity: () => {} })

        writer().onStoryMerged("S1", "deadbeef")
        const afterOwnerWrite = readRaw(path)
        persistPrdPreserving(path, stale)
        const afterSnapshotWrite = readRaw(path)
        writer().onStoryFailed("S2")
        return { path, afterOwnerWrite, afterSnapshotWrite }
    }

    it("loses no per-story merge field across the intervening snapshot write", () => {
        const { path, afterSnapshotWrite } = interleave()

        // The middle full-file write is the one that used to erase these.
        assert.equal(
            afterSnapshotWrite.userStories.find((s: any) => s.id === "S1")
                .mergeStatus,
            "merged",
        )
        assert.equal(diskStory(path, "S1").mergeStatus, "merged")
        assert.equal(diskStory(path, "S1").mergeCommitSha, "deadbeef")
        assert.equal(diskStory(path, "S2").mergeStatus, "failed")
    })

    it("never drops a goalFingerprint that is on disk when it runs", () => {
        // Asserted against whatever the preceding owner write left behind, so
        // this holds regardless of how prd-status-writer persists: the helper's
        // contract is that it carries the disk value across its own write.
        const { afterOwnerWrite, afterSnapshotWrite } = interleave()

        assert.equal(
            afterSnapshotWrite.goalFingerprint,
            afterOwnerWrite.goalFingerprint,
        )
    })

    it("keeps all three fields correct when the status writer's save seam uses the helper", () => {
        // The one-line correction the challenge asks for, exercised through
        // prd-status-writer.ts's own documented `save` option so its
        // load-modify-write ownership mechanism stays untouched.
        const { path } = interleave(persistPrdPreserving)

        assert.equal(readRaw(path).goalFingerprint, "abc123")
        assert.equal(diskStory(path, "S1").mergeStatus, "merged")
        assert.equal(diskStory(path, "S1").mergeCommitSha, "deadbeef")
        assert.equal(diskStory(path, "S2").mergeStatus, "failed")
    })
})
