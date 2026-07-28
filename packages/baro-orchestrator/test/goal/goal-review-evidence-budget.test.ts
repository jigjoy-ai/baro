import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { prepareGoalInvariantReview } from "../../src/goal/goal-invariant-review-evidence.js"
import { withTempDir } from "../execution/helpers.js"

const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" })

function repository(cwd: string): string {
    git(cwd, "init", "--quiet")
    writeFileSync(join(cwd, "slugify.js"), "module.exports = () => ''\n")
    git(cwd, "add", "-A")
    git(
        cwd,
        "-c",
        "user.name=Baro Test",
        "-c",
        "user.email=baro@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
    )
    return git(cwd, "rev-parse", "HEAD").trim()
}

function request(): never {
    return {
        basis: {
            fingerprint: "f".repeat(64),
            contractId: "goal:test",
            objective: "Build a slugify CLI.",
            nonGoals: [],
            assumptions: [],
            verificationId: "verification-1",
            storyIds: ["S1"],
            invariants: [
                {
                    invariantId: "G-A1",
                    text: "the CLI prints a slug",
                    mappedStoryIds: ["S1"],
                    contributions: [],
                },
            ],
            challenges: [],
            protocolIssues: [],
        },
    } as never
}

function verification(): never {
    return {
        verificationId: "verification-1",
        status: "passed",
        commands: [{ command: "npm test", status: "passed", durationMs: 12 }],
        durationMs: 12,
    } as never
}

describe("goal aggregate evidence capture", () => {
    it("names an exhausted capture budget instead of a silent git kill", async () => {
        // A near-expired deadline used to hand git a 1ms timeout: the process
        // died on SIGTERM with an empty stderr, and the run failed closed on
        // "no diagnostic output" — undiagnosable, on work that had passed.
        await withTempDir("baro-goal-evidence-budget-", async (cwd) => {
            const baseSha = repository(cwd)
            const preparation = await prepareGoalInvariantReview(
                cwd,
                baseSha,
                request(),
                verification(),
                { signal: new AbortController().signal, deadlineAt: Date.now() + 50 },
            )

            assert.equal(preparation.status, "inconclusive")
            const reason = preparation.issues.join(" ")
            assert.match(reason, /capture budget is exhausted/u)
            assert.doesNotMatch(reason, /no diagnostic output/u)
        })
    })

    it("reports a genuinely missing base commit in words", async () => {
        await withTempDir("baro-goal-evidence-missing-base-", async (cwd) => {
            repository(cwd)
            const absent = "0".repeat(40)
            const preparation = await prepareGoalInvariantReview(
                cwd,
                absent,
                request(),
                verification(),
                {
                    signal: new AbortController().signal,
                    deadlineAt: Date.now() + 30_000,
                },
            )

            // git names this one itself; the point is that the reason reaches
            // the caller instead of being swallowed.
            assert.equal(preparation.status, "inconclusive")
            const reason = preparation.issues.join(" ")
            assert.match(reason, new RegExp(`Not a valid object name.*${absent}`, "u"))
            assert.doesNotMatch(reason, /no diagnostic output/u)
        })
    })
})
