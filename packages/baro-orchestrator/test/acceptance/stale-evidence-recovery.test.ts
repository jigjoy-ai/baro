import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
    prepareCriticEvaluation,
    type CriticEvidenceSource,
} from "../../src/acceptance/critic-evidence.js"
import {
    snapshotTurnReview,
    turnReviewDisposition,
} from "../../src/acceptance/turn-review.js"
import { oneShotSurgicalRevisionPrompt } from "../../src/harness/one-shot/turn-review.js"
import type { CritiqueData } from "../../src/semantic-events.js"
import { withTempDir } from "../execution/helpers.js"

function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" })
}

function inconclusive(overrides: Partial<CritiqueData> = {}): CritiqueData {
    return {
        agentId: "S1",
        terminalId: "t-1",
        status: "inconclusive",
        verdict: "fail",
        reasoning:
            "Critic could not evaluate the candidate: command evidence is stale or unverifiable",
        violatedCriteria: ["[acceptance evidence unavailable]"],
        turn: 1,
        modelUsed: "test",
        ...overrides,
    }
}

describe("stale command evidence is repaired, not fatal", () => {
    it("sends the agent back to re-run instead of handing an unjudged candidate to the gate", () => {
        const disposition = turnReviewDisposition(
            "t-1",
            inconclusive({ staleCommands: ["npm test -- src/audit"] }),
            { handoffInconclusiveToAcceptanceGate: true },
        )
        assert.equal(disposition.kind, "revise")
        assert.ok(disposition.kind === "revise")
        assert.match(disposition.feedback, /npm test -- src\/audit/)
        assert.match(disposition.feedback, /LAST thing you do/)
    })

    it("still hands over an inconclusive verdict the agent cannot repair", () => {
        assert.equal(
            turnReviewDisposition("t-1", inconclusive(), {
                handoffInconclusiveToAcceptanceGate: true,
            }).kind,
            "handoff",
        )
        assert.equal(
            turnReviewDisposition("t-1", inconclusive({ staleCommands: [] }), {
                handoffInconclusiveToAcceptanceGate: true,
            }).kind,
            "handoff",
        )
    })

    it("asks a fresh one-shot process to restore the proof, not to hunt a defect", () => {
        const prompt = oneShotSurgicalRevisionPrompt(
            "contract text",
            inconclusive({ staleCommands: ["npm test"] }),
        )
        assert.match(prompt, /never judged/)
        assert.match(prompt, /Change nothing unless a command fails/)
        assert.doesNotMatch(prompt, /surgical repair/)
    })

    it("copies the command list so a retained review cannot be mutated later", () => {
        const commands = ["npm test"]
        const snapshot = snapshotTurnReview(
            inconclusive({ staleCommands: commands }),
        )
        commands.push("rm -rf /")
        assert.deepEqual(snapshot.staleCommands, ["npm test"])
    })

    it("names stale commands only when staleness is the sole blocker", async () => {
        await withTempDir("baro-stale-evidence-", async (repo) => {
            git(repo, "init", "--quiet")
            writeFileSync(join(repo, "tracked.ts"), "export const value = 1\n")
            git(repo, "add", "tracked.ts")
            git(
                repo,
                "-c",
                "user.name=Baro Test",
                "-c",
                "user.email=test@baro.local",
                "commit",
                "--quiet",
                "-m",
                "base",
            )
            const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: repo,
                encoding: "utf8",
            }).trim()
            writeFileSync(join(repo, "tracked.ts"), "export const value = 2\n")

            const staleCommand = {
                command: "npm test -- src/audit",
                terminal: true,
                freshness: "stale" as const,
                sandboxBlocked: false,
            }
            const commandEvidence = () => ({
                text: "### Command 1\ncommand: npm test -- src/audit\n",
                commands: [staleCommand],
            })

            const repairable = await prepareCriticEvaluation(
                ["criterion"],
                "output",
                "S1",
                {
                    resolveRepositoryTarget: () => ({ cwd: repo, baseSha }),
                    commandEvidence,
                } satisfies CriticEvidenceSource,
            )
            assert.equal(repairable.status, "inconclusive")
            assert.deepEqual(repairable.staleCommands, [
                "npm test -- src/audit",
            ])

            // A broken repository target is host work; re-running proves nothing.
            const unrepairable = await prepareCriticEvaluation(
                ["criterion"],
                "output",
                "S1",
                {
                    resolveRepositoryTarget: () => null,
                    commandEvidence,
                } satisfies CriticEvidenceSource,
            )
            assert.equal(unrepairable.status, "inconclusive")
            assert.deepEqual(unrepairable.staleCommands, [])

            // A sandbox-blocked command is not evidence the agent can refresh.
            const blocked = await prepareCriticEvaluation(
                ["criterion"],
                "output",
                "S1",
                {
                    resolveRepositoryTarget: () => ({ cwd: repo, baseSha }),
                    commandEvidence: () => ({
                        text: "### Command 1\ncommand: npm test\n",
                        commands: [
                            { ...staleCommand, sandboxBlocked: true },
                        ],
                    }),
                } satisfies CriticEvidenceSource,
            )
            assert.deepEqual(blocked.staleCommands, [])
        })
    })
})
