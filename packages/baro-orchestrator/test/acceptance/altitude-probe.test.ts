import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"

import { collectAltitudeFindings } from "../../src/acceptance/altitude-probe.js"
import { withTempDir } from "../execution/helpers.js"

const TIMEOUT_MS = 30_000

describe("altitude probe", () => {
    it("reports a pre-existing large file that grew past both thresholds", async () => {
        await withTempDir("baro-altitude-", async (repo) => {
            baseline(repo, {
                "src/big.ts": lines(1500),
                "src/below-growth.ts": lines(1500),
                "src/small.ts": lines(100),
                "test/helper.ts": lines(1500),
            })
            append(repo, "src/big.ts", 80)
            append(repo, "src/below-growth.ts", 79)
            append(repo, "src/small.ts", 80)
            append(repo, "test/helper.ts", 80)

            const findings = await collectAltitudeFindings({
                cwd: repo,
                baseSha: baseSha(repo),
                timeoutMs: TIMEOUT_MS,
            })

            assert.deepEqual(findings, [
                { path: "src/big.ts", totalLines: 1580, addedLines: 80 },
            ])
        })
    })

    it("never reports a newly added large file", async () => {
        await withTempDir("baro-altitude-new-", async (repo) => {
            baseline(repo, { "src/existing.ts": lines(10) })
            const base = baseSha(repo)
            write(repo, "src/fresh.ts", lines(2000))
            git(repo, "add", "src/fresh.ts")
            // Untracked mass is reported by `git ls-files --others` and must be
            // treated as new by the same union.
            write(repo, "src/untracked.ts", lines(2000))

            const findings = await collectAltitudeFindings({
                cwd: repo,
                baseSha: base,
                timeoutMs: TIMEOUT_MS,
            })

            assert.deepEqual(findings, [])
        })
    })

    it("drops exempt paths before the read budget is spent", async () => {
        await withTempDir("baro-altitude-exempt-", async (repo) => {
            // The exempt path sorts ahead of every source file, so it would
            // consume one of the 25 read slots if it were filtered after the
            // read set was chosen — src/f25.ts would then lose its finding.
            const files: Record<string, string> = {
                "__tests__/grown.ts": lines(1500),
            }
            const sources = Array.from(
                { length: 26 },
                (_, index) => `src/f${String(index + 1).padStart(2, "0")}.ts`,
            )
            for (const path of sources) files[path] = lines(1500)
            baseline(repo, files)
            for (const path of Object.keys(files)) append(repo, path, 80)

            const findings = await collectAltitudeFindings({
                cwd: repo,
                baseSha: baseSha(repo),
                timeoutMs: TIMEOUT_MS,
            })

            assert.deepEqual(findings.map((finding) => finding.path), sources.slice(0, 25))
            for (const finding of findings) {
                assert.equal(finding.totalLines, 1580)
                assert.equal(finding.addedLines, 80)
            }
        })
    })

    it("skips files larger than the read ceiling", async () => {
        await withTempDir("baro-altitude-huge-", async (repo) => {
            const wide = `${"w".repeat(3000)}\n`.repeat(1500)
            baseline(repo, { "src/wide.ts": wide })
            append(repo, "src/wide.ts", 80)

            const findings = await collectAltitudeFindings({
                cwd: repo,
                baseSha: baseSha(repo),
                timeoutMs: TIMEOUT_MS,
            })

            assert.deepEqual(findings, [])
        })
    })

    it("resolves to no findings when git cannot answer", async () => {
        await withTempDir("baro-altitude-bad-base-", async (repo) => {
            baseline(repo, { "src/big.ts": lines(1500) })
            append(repo, "src/big.ts", 80)

            assert.deepEqual(
                await collectAltitudeFindings({
                    cwd: repo,
                    baseSha: "deadbeef",
                    timeoutMs: TIMEOUT_MS,
                }),
                [],
            )
        })
    })

    it("resolves to no findings outside a repository", async () => {
        await withTempDir("baro-altitude-no-repo-", async (dir) => {
            write(dir, "src/big.ts", lines(1600))

            assert.deepEqual(
                await collectAltitudeFindings({
                    cwd: dir,
                    baseSha: "HEAD",
                    timeoutMs: TIMEOUT_MS,
                }),
                [],
            )
        })
    })
})

function lines(count: number, offset = 0): string {
    let text = ""
    for (let index = 0; index < count; index += 1) {
        text += `line ${offset + index}\n`
    }
    return text
}

function write(repo: string, path: string, content: string): void {
    const absolute = join(repo, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
}

function append(repo: string, path: string, count: number): void {
    const absolute = join(repo, path)
    writeFileSync(absolute, lines(count, 100_000), { flag: "a" })
}

function baseline(repo: string, files: Record<string, string>): void {
    git(repo, "init", "--quiet")
    for (const [path, content] of Object.entries(files)) write(repo, path, content)
    git(repo, "add", "-A")
    git(
        repo,
        "-c",
        "user.name=Baro Test",
        "-c",
        "user.email=baro@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "baseline",
    )
}

function baseSha(repo: string): string {
    return git(repo, "rev-parse", "HEAD").trim()
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" })
}
