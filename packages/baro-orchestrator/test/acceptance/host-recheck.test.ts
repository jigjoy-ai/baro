import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "@rstest/core"

import {
    prepareCriticEvaluation,
    type CriticEvidenceSource,
} from "../../src/acceptance/critic-evidence.js"
import { HostRecheck, matchGateSpecs } from "../../src/acceptance/host-recheck.js"
import type { VerifyCommandResult, VerifyCommandSpec } from "../../src/verification/verify.js"
import { withTempDir } from "../execution/helpers.js"

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
        },
    })
}

/** A repository with one package that declares a typecheck and a test gate. */
function repo(root: string): { dir: string; base: string } {
    const dir = join(root, "repo")
    mkdirSync(join(dir, "packages", "core"), { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }))
    writeFileSync(
        join(dir, "packages", "core", "package.json"),
        JSON.stringify({ name: "core", scripts: { typecheck: "tsc", test: "node --test" } }),
    )
    writeFileSync(join(dir, "packages", "core", "a.ts"), "export const a = 1\n")
    git(dir, "init", "-q", "-b", "main")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "base")
    return { dir, base: git(dir, "rev-parse", "HEAD").trim() }
}

function spec(label: string, args: string[], cwd?: string): VerifyCommandSpec {
    return { label, tool: "npm", args, ...(cwd ? { cwd } : {}) }
}

/** Gate outcomes keyed by whether the checkout carries the story's edit. */
function seams(outcome: (edited: boolean, label: string) => VerifyCommandResult["status"]) {
    const runs: Array<{ edited: boolean; labels: readonly string[] }> = []
    return {
        runs,
        checkout: async (repoCwd: string, rev: string, dir: string) => {
            mkdirSync(dir, { recursive: true })
            const file = git(repoCwd, "show", `${rev}:packages/core/a.ts`)
            writeFileSync(join(dir, "a.ts"), file)
        },
        runGates: async (dir: string, labels: readonly string[]): Promise<VerifyCommandResult[]> => {
            const edited = readFileSync(join(dir, "a.ts"), "utf8").includes("2")
            runs.push({ edited, labels })
            return labels.map((label) => ({
                command: label,
                status: outcome(edited, label),
                durationMs: 1,
                tail: `${label} ${edited ? "story" : "base"} output`,
            }))
        },
    }
}

describe("matchGateSpecs", () => {
    const root = "/r"
    const specs = [
        spec("npm run typecheck (packages/core)", ["run", "typecheck"], "/r/packages/core"),
        spec("npm run typecheck (packages/web)", ["run", "typecheck"], "/r/packages/web"),
        spec("npm run test", ["run", "test"]),
    ]

    it("matches a gate run in its own directory, through redirects and pipes", () => {
        const found = matchGateSpecs(root, "cd packages/core && npm run typecheck 2>&1 | tail -5", specs, [])
        assert.deepEqual(found.map((s) => s.label), ["npm run typecheck (packages/core)"])
    })

    it("narrows a name several packages share to the ones the story changed", () => {
        const found = matchGateSpecs(root, "npm run typecheck", specs, ["packages/web/src/x.ts"])
        assert.deepEqual(found.map((s) => s.label), ["npm run typecheck (packages/web)"])
    })

    it("never matches a command that is not the gate's own argv", () => {
        assert.deepEqual(matchGateSpecs(root, "npm run typecheck -- --noEmit false", specs, ["packages/core/a.ts"]), [])
        assert.deepEqual(matchGateSpecs(root, "npx tsc -p tsconfig.json", specs, ["packages/core/a.ts"]), [])
        assert.deepEqual(matchGateSpecs(root, "cd packages/web && npm run test", specs, []), [])
        assert.deepEqual(matchGateSpecs(root, "cd ../elsewhere && npm run test", specs, []), [])
    })
})

describe("HostRecheck", () => {
    it("reports a gate that passes outside the sandbox and never checks the base", async () => {
        await withTempDir("baro-recheck-", async (root) => {
            const { dir, base } = repo(root)
            writeFileSync(join(dir, "packages", "core", "a.ts"), "export const a = 2\n")
            const s = seams(() => "passed")
            const recheck = new HostRecheck({ hostRoot: dir, checkout: s.checkout, runGates: s.runGates, scratchRoot: join(root, "scratch") })

            const section = await recheck.section({
                cwd: dir,
                baseSha: base,
                failedCommands: ["cd packages/core && npm run typecheck", "grep -rn foo src"],
            })

            assert.ok(section)
            assert.match(section, /`npm run typecheck \(packages\/core\)`\nstory's files: passed/)
            assert.deepEqual(s.runs, [{ edited: true, labels: ["npm run typecheck (packages/core)"] }])
            // The story's own index and files are untouched by the snapshot.
            assert.equal(git(dir, "status", "--porcelain").trim(), "M packages/core/a.ts")
            assert.equal(git(dir, "worktree", "list").trim().split("\n").length, 1)
        })
    })

    it("shows a gate failing on the story's files next to the base, and checks the base once", async () => {
        await withTempDir("baro-recheck-", async (root) => {
            const { dir, base } = repo(root)
            writeFileSync(join(dir, "packages", "core", "a.ts"), "export const a = 2\n")
            const s = seams(() => "failed")
            const recheck = new HostRecheck({ hostRoot: dir, checkout: s.checkout, runGates: s.runGates, scratchRoot: join(root, "scratch") })
            const request = { cwd: dir, baseSha: base, failedCommands: ["cd packages/core && npm run test"] }

            const first = await recheck.section(request)
            await recheck.section(request)

            assert.ok(first)
            assert.match(first, /story's files: failed\n```\nnpm run test \(packages\/core\) story output\n```/)
            assert.match(first, /base commit: failed\n```\nnpm run test \(packages\/core\) base output\n```/)
            assert.deepEqual(s.runs.map((run) => run.edited), [true, false, true])
        })
    })

    it("says nothing when no failed command is a repository gate", async () => {
        await withTempDir("baro-recheck-", async (root) => {
            const { dir, base } = repo(root)
            const s = seams(() => "failed")
            const recheck = new HostRecheck({ hostRoot: dir, checkout: s.checkout, runGates: s.runGates })

            assert.equal(await recheck.section({ cwd: dir, baseSha: base, failedCommands: ["node scratch.js"] }), null)
            assert.deepEqual(s.runs, [])
        })
    })

    it("reaches the Critic's prompt for a failed gate command, stale ones included", async () => {
        await withTempDir("baro-recheck-", async (root) => {
            const { dir, base } = repo(root)
            const requests: string[][] = []
            const source: CriticEvidenceSource = {
                resolveRepositoryTarget: () => ({ cwd: dir, baseSha: base }),
                commandEvidence: () => ({
                    text: "### Command 1\ncommand: npm run test\ncaptured output:\nnpm error Lifecycle script `test` failed",
                    commands: [
                        { command: "npm run test", terminal: true, freshness: "fresh", sandboxBlocked: false, toolUnavailable: false, failed: true },
                        { command: "npm run typecheck", terminal: true, freshness: "stale", sandboxBlocked: false, toolUnavailable: false, failed: true },
                        { command: "ls", terminal: true, freshness: "fresh", sandboxBlocked: false, toolUnavailable: false, failed: false },
                    ],
                }),
                hostRecheck: async (request) => {
                    requests.push([...request.failedCommands])
                    return "## Host recheck of failing gate commands\nstory's files: passed"
                },
            }

            const preparation = await prepareCriticEvaluation(["tests pass"], "done", "S1", source)

            assert.deepEqual(requests, [["npm run test", "npm run typecheck"]])
            assert.match(preparation.prompts.join("\n"), /## Host recheck of failing gate commands\nstory's files: passed/)
        })
    })
})
