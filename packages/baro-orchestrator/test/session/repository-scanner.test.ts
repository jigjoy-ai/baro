import assert from "node:assert/strict"
import {
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { basename, join } from "node:path"
import { describe, it } from "node:test"

import { DeterministicRepositoryScanner } from "../../src/session/repository-scanner.js"
import { withTempDir } from "../participants/helpers.js"

describe("DeterministicRepositoryScanner", () => {
    it("is goal-aware, root-contained, secret-excluding, deterministic, and read-only", async () => {
        await withTempDir("baro-repository-scout-", async (dir) => {
            const root = join(dir, "repo")
            const outside = join(dir, "outside")
            mkdirSync(join(root, "src"), { recursive: true })
            mkdirSync(join(root, ".ssh"), { recursive: true })
            mkdirSync(join(root, ".docker"), { recursive: true })
            mkdirSync(join(root, ".baro"), { recursive: true })
            mkdirSync(outside)
            writeFileSync(join(root, "README.md"), "A small payment service.\n")
            writeFileSync(
                join(root, "src", "billing-adapter.ts"),
                "export function reconcileBillingReceipt() { return true }\n",
            )
            writeFileSync(join(root, "src", "unrelated.ts"), "export const color = 'blue'\n")
            writeFileSync(join(root, ".env"), "API_KEY=never-leak-this\n")
            writeFileSync(join(root, "private.pem"), "PRIVATE KEY never-leak-pem\n")
            writeFileSync(join(root, ".ssh", "id_rsa"), "never-leak-ssh\n")
            writeFileSync(join(root, ".docker", "config.json"), "never-leak-docker\n")
            writeFileSync(join(root, ".baro", "events.json"), "never-leak-baro\n")
            writeFileSync(join(outside, "outside-secret.ts"), "never-leak-outside\n")
            symlinkSync(
                join(outside, "outside-secret.ts"),
                join(root, "src", "escape.ts"),
            )
            symlinkSync(outside, join(root, "linked-directory"))

            const before = snapshotTree(root)
            const scanner = new DeterministicRepositoryScanner(root)
            const first = await scanner.scan({
                intent: "goal",
                query: "../../outside reconcile the billing receipt adapter",
            }, new AbortController().signal)
            const replay = await scanner.scan({
                intent: "goal",
                query: "../../outside reconcile the billing receipt adapter",
            }, new AbortController().signal)
            const after = snapshotTree(root)

            assert.equal(first.snapshotId, replay.snapshotId)
            assert.deepEqual(first, replay)
            assert.deepEqual(after, before, "scanner must not create or modify repository files")
            assert.equal(Object.isFrozen(first), true)
            assert.equal(first.relevantPaths[0], "src/billing-adapter.ts")
            assert.ok(first.facts.some((fact) =>
                fact.evidencePath === "src/billing-adapter.ts" && fact.line === 1,
            ))
            for (const path of first.relevantPaths) {
                assert.equal(path.startsWith("/"), false)
                assert.equal(path.includes(".."), false)
                assert.equal(path.includes("\\"), false)
            }
            const serialized = JSON.stringify(first)
            assert.doesNotMatch(
                serialized,
                /never-leak|\.env|private\.pem|id_rsa|escape\.ts|\.docker|\.baro/,
            )
            assert.match(serialized, /Symbolic links were excluded/)

            writeFileSync(
                join(root, "src", "billing-adapter.ts"),
                "export function reconcileBillingReceipt() { return false }\n",
            )
            const changed = await scanner.scan({
                intent: "goal",
                query: "reconcile the billing receipt adapter",
            }, new AbortController().signal)
            assert.notEqual(changed.snapshotId, first.snapshotId)
        })
    })

    it("reports truncation while keeping the brief bounded", async () => {
        await withTempDir("baro-repository-scout-bound-", async (root) => {
            writeFileSync(join(root, "a.ts"), "billing adapter\n")
            writeFileSync(join(root, "b.ts"), "billing receipt\n")
            const scanner = new DeterministicRepositoryScanner(root, {
                maxFiles: 1,
                maxTotalBytes: 64,
                maxFileBytes: 64,
            })
            const brief = await scanner.scan({
                intent: "clarification",
                query: "billing adapter",
            }, new AbortController().signal)
            assert.equal(brief.truncated, true)
            assert.match(brief.unknowns.join(" "), /configured file, byte, or directory-entry bound/)
            assert.ok(Buffer.byteLength(JSON.stringify(brief), "utf8") <= 64 * 1024)
        })
    })

    it("bounds directory collection before traversing an oversized directory", async () => {
        await withTempDir("baro-repository-scout-entries-", async (root) => {
            for (let index = 0; index < 12; index += 1) {
                writeFileSync(
                    join(root, `billing-${String(index).padStart(2, "0")}.ts`),
                    `export const billing${index} = true\n`,
                )
            }
            const scanner = new DeterministicRepositoryScanner(root, {
                maxEntries: 4,
                maxFiles: 12,
            })
            const brief = await scanner.scan({
                intent: "goal",
                query: "billing",
            }, new AbortController().signal)

            assert.equal(brief.truncated, true)
            assert.equal(brief.relevantPaths.length, 4)
            assert.match(brief.summary, /indexed 4 text file\(s\)/)
            assert.match(
                brief.unknowns.join(" "),
                /configured file, byte, or directory-entry bound/,
            )
        })
    })

    it("fails before traversal when already aborted", async () => {
        await withTempDir("baro-repository-scout-abort-", async (root) => {
            writeFileSync(join(root, "index.ts"), "billing\n")
            const controller = new AbortController()
            controller.abort()
            await assert.rejects(
                new DeterministicRepositoryScanner(root).scan({
                    intent: "goal",
                    query: "billing",
                }, controller.signal),
                /aborted/,
            )
        })
    })
})

function snapshotTree(root: string): Record<string, string> {
    const snapshot: Record<string, string> = {}
    const walk = (directory: string, prefix: string): void => {
        for (const entry of readdirSync(directory).sort()) {
            const absolute = join(directory, entry)
            const relative = prefix ? `${prefix}/${entry}` : entry
            const metadata = lstatSync(absolute)
            if (metadata.isSymbolicLink()) {
                snapshot[relative] = `symlink:${readlinkSync(absolute)}`
            } else if (metadata.isDirectory()) {
                snapshot[`${relative}/`] = "directory"
                walk(absolute, relative)
            } else {
                snapshot[relative] = `file:${readFileSync(absolute).toString("base64")}`
            }
        }
    }
    walk(root, "")
    assert.equal(basename(root), "repo")
    return snapshot
}
