import assert from "node:assert/strict"
import { setImmediate as setImmediatePromise } from "node:timers/promises"
import { describe, it } from "node:test"

import {
    assertSupportedCriticBackend,
    resolveCriticRepositoryTarget,
    withCriticEvidenceBarrier,
} from "../src/orchestrate.js"

describe("orchestrate Critic evidence lifecycle", () => {
    it("fails fast when the enabled Critic is routed to unsafe Codex CLI inference", () => {
        assert.throws(
            () => assertSupportedCriticBackend(true, "codex"),
            /--critic-llm claude\|openai\|opencode\|pi.*--no-critic/,
        )
        assert.doesNotThrow(() => assertSupportedCriticBackend(false, "codex"))
        assert.doesNotThrow(() => assertSupportedCriticBackend(true, "openai"))
    })

    it("does not attribute the shared run tree to a story without an active worktree", () => {
        assert.equal(resolveCriticRepositoryTarget(null, "S1"), null)
        assert.equal(
            resolveCriticRepositoryTarget(
                {
                    activePath: () => null,
                    creationSha: () => "run-wide-base",
                },
                "S1",
            ),
            null,
        )
    })

    it("resolves only the exact active isolated story target", () => {
        assert.deepEqual(
            resolveCriticRepositoryTarget(
                {
                    activePath: (storyId) =>
                        storyId === "S1" ? "/tmp/story-S1" : null,
                    creationSha: (storyId) =>
                        storyId === "S1" ? "story-base" : null,
                },
                "S1",
            ),
            { cwd: "/tmp/story-S1", baseSha: "story-base" },
        )
    })

    it("does not start repository cleanup until Critic evidence is idle", async () => {
        const order: string[] = []
        let releaseIdle!: () => void
        const idleGate = new Promise<void>((resolve) => {
            releaseIdle = resolve
        })

        const lifecycle = withCriticEvidenceBarrier(
            {
                idle: async () => {
                    order.push("critic-idle-start")
                    await idleGate
                    order.push("critic-idle-complete")
                },
            },
            async () => {
                order.push("repository-cleanup")
            },
        )

        await setImmediatePromise()
        assert.deepEqual(order, ["critic-idle-start"])
        releaseIdle()
        await lifecycle
        assert.deepEqual(order, [
            "critic-idle-start",
            "critic-idle-complete",
            "repository-cleanup",
        ])
    })
})
