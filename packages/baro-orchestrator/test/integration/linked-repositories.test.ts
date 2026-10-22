import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    buildLinkedRepositoryReports,
    linkedRepositoryLogLines,
    patchesDependency,
    renderLinkedRepositoriesSection,
} from "../../src/integration/linked-repositories.js"
import { loadPrd, normalizePrd, persistPrdPreserving, type PrdFile } from "../../src/prd.js"
import { withTempDir } from "../execution/helpers.js"

const engine = {
    name: "bedem",
    path: "/work/bedem",
    package: "@kornelija-hse-project/bedem-core",
    dependency: 'package.json dependencies "@kornelija-hse-project/bedem-core": "^0.6.89"',
    branch: "main",
    headSha: "1111111aaaaaaa",
}

describe("linked repositories", () => {
    it("recognizes every install-time patch layout of a scoped dependency", () => {
        const pkg = "@kornelija-hse-project/bedem-core"
        for (const path of [
            "patches/@kornelija-hse-project__bedem-core@0.6.89.patch",
            "patches/@kornelija-hse-project+bedem-core+0.6.89.patch",
            ".yarn/patches/@kornelija-hse-project-bedem-core-npm-0.6.89-abc123.patch",
            "apps/web/node_modules/@kornelija-hse-project/bedem-core/dist/index.js",
        ]) {
            assert.ok(patchesDependency(path, pkg), path)
        }
        for (const path of [
            "patches/@kornelija-hse-project__bedem-core-extra@1.0.0.patch",
            "src/@kornelija-hse-project__bedem-core@0.6.89.ts",
            "package.json",
        ]) {
            assert.ok(!patchesDependency(path, pkg), path)
        }
        assert.ok(patchesDependency("patches/engine@1.2.0.patch", "engine"))
        assert.ok(!patchesDependency("patches/engine-sys@1.2.0.patch", "engine"))
    })

    it("reports a moved HEAD and in-place dependency patches, and stays quiet otherwise", async () => {
        const schema = { name: "schema", path: "/work/schema", headSha: "2222222bbbbbbb" }
        const reports = await buildLinkedRepositoryReports(
            [engine, schema],
            ["src/editor.tsx", "patches/@kornelija-hse-project__bedem-core@0.6.89.patch"],
            async (path) => (path === engine.path ? "3333333ccccccc" : schema.headSha),
        )

        assert.deepEqual(reports, [
            {
                repo: engine,
                movedTo: "3333333ccccccc",
                patchedBy: ["patches/@kornelija-hse-project__bedem-core@0.6.89.patch"],
            },
            { repo: schema, patchedBy: [] },
        ])

        const body = renderLinkedRepositoriesSection(reports).join("\n")
        assert.match(body, /^## Linked repositories/)
        assert.match(body, /No branch, commit or pull request was created in the linked repositories/)
        assert.match(body, /- \*\*bedem\*\* — `\/work\/bedem` \(package `@kornelija-hse-project\/bedem-core`; consumed via package\.json dependencies/)
        assert.match(body, /HEAD moved during the run: `1111111` → `3333333`/)
        assert.match(body, /patches the installed `@kornelija-hse-project\/bedem-core` instead of its source/)
        assert.match(body, /- \*\*schema\*\* — `\/work\/schema`\n/)

        const logs = linkedRepositoryLogLines(reports)
        assert.equal(logs.length, 4)
        assert.match(logs[0], /linked repository bedem \(\/work\/bedem\): no branch, commit or PR from this run/)
        assert.deepEqual(renderLinkedRepositoriesSection([]), [])
    })

    it("does not read HEAD when none was recorded and treats an unreadable HEAD as unmoved", async () => {
        let reads = 0
        const reports = await buildLinkedRepositoryReports(
            [{ name: "x", path: "/x" }, { ...engine, package: undefined }],
            ["node_modules/whatever/index.js"],
            async () => {
                reads++
                return null
            },
        )
        assert.equal(reads, 1)
        assert.deepEqual(reports.map((report) => [report.movedTo, report.patchedBy]), [
            [undefined, []],
            [undefined, []],
        ])
    })

    it("normalizes PRD linked repositories, dropping malformed entries", () => {
        const prd = normalizePrd(
            {
                project: "p",
                branchName: "baro/p",
                description: "d",
                userStories: [],
                linkedRepositories: [
                    engine,
                    { name: "", path: "/empty-name" },
                    { name: "no-path" },
                    "nonsense",
                    { name: "lean", path: "/lean", package: 7, branch: " " },
                ] as unknown as PrdFile["linkedRepositories"],
            },
            "test",
        )
        assert.deepEqual(prd.linkedRepositories, [engine, { name: "lean", path: "/lean" }])
        assert.equal(
            "linkedRepositories" in normalizePrd({ project: "p", userStories: [] }, "test"),
            false,
        )
    })

    it("survives loadPrd and a full-file write from a snapshot that never carried it", async () => {
        await withTempDir("baro-linked-prd-", async (dir) => {
            const path = join(dir, "prd.json")
            const base = { project: "p", branchName: "baro/p", description: "d", userStories: [] }
            writeFileSync(path, JSON.stringify({ ...base, linkedRepositories: [engine] }))

            assert.deepEqual(loadPrd(path).linkedRepositories, [engine])

            persistPrdPreserving(path, base)
            assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).linkedRepositories, [engine])
        })
    })
})
