import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { createPrdStatusWriter } from "../../src/execution/prd-status-writer.js"
import {
    persistPrdPreserving,
    savePrdAtomic,
    type PrdFile,
    type PrdStory,
} from "../../src/prd.js"

const temporaryRoots: string[] = []

after(() => {
    for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true })
})

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
 * Fixture and read-back are both RAW JSON: `goalFingerprint` is not a `PrdFile`
 * member, so `savePrd` could not put it on disk and `loadPrd` would strip it
 * back off — making every assertion about it vacuously pass.
 */
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "prd-status-preserve-"))
    temporaryRoots.push(root)
    const path = join(root, "prd.json")
    writeFileSync(
        path,
        JSON.stringify(
            { ...prdFile(story("S1"), story("S2")), goalFingerprint: "abc123" },
            null,
            2,
        ) + "\n",
    )
    return path
}

function readRaw(path: string): Record<string, any> {
    return JSON.parse(readFileSync(path, "utf8"))
}

function diskStory(path: string, id: string): Record<string, any> {
    const found = readRaw(path).userStories.find((s: any) => s.id === id)
    assert.ok(found, `story ${id} missing from ${path}`)
    return found
}

/**
 * The O-001/O-016 sequence. The snapshot handed to the middle write is captured
 * BEFORE the status writer runs, which is what makes it a genuine lost-update
 * candidate. `save` left undefined means the writer's own documented default.
 */
function interleave(save?: (path: string, prd: PrdFile) => void): string {
    const path = fixture()
    const stale = prdFile(story("S1"), story("S2"))
    const writer = () =>
        save === undefined
            ? createPrdStatusWriter({ prdPath: path })
            : createPrdStatusWriter({ prdPath: path, save })

    writer().onStoryMerged("S1", "deadbeef")
    persistPrdPreserving(path, stale)
    writer().onStoryFailed("S2")
    return path
}

describe("prd-status-writer preserves foreign-owned fields at its defaults", () => {
    it("keeps the Rust goalFingerprint stamp across a single bare status write", () => {
        const path = fixture()

        createPrdStatusWriter({ prdPath: path }).onStoryMerged("S1", "deadbeef")

        // The writer loads through `loadPrd`, whose normalization has no
        // `goalFingerprint` slot; only the preserving save default carries the
        // Rust stamp (crates/baro-tui/src/main.rs:3945) back to disk.
        assert.equal(readRaw(path).goalFingerprint, "abc123")
        assert.equal(diskStory(path, "S1").mergeStatus, "merged")
        assert.equal(diskStory(path, "S1").mergeCommitSha, "deadbeef")
    })

    it("leaves all three foreign-owned fields correct with the writer bare", () => {
        // G-A1 clause (3), end to end and literally: no injected `save`, no
        // injected `load` — status-write → full-file persist → status-write.
        const path = interleave()

        assert.equal(readRaw(path).goalFingerprint, "abc123")
        assert.equal(diskStory(path, "S1").mergeStatus, "merged")
        assert.equal(diskStory(path, "S1").mergeCommitSha, "deadbeef")
        assert.equal(diskStory(path, "S2").mergeStatus, "failed")
    })

    it("loses the stamp when the writer saves through the pre-fix primitive", () => {
        // Non-vacuity control: the same sequence with the writer's former
        // default. The stamp dies on the FIRST status write, before the
        // full-file persist runs, so the per-story fields still survive — which
        // is why only a goalFingerprint assertion can detect this regression.
        const path = interleave(savePrdAtomic)

        assert.equal(readRaw(path).goalFingerprint, undefined)
        assert.equal(diskStory(path, "S1").mergeStatus, "merged")
        assert.equal(diskStory(path, "S2").mergeStatus, "failed")
    })
})
