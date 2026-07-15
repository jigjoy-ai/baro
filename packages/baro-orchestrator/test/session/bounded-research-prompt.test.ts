import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildBoundedResearchPrompt } from "../../src/session/bounded-research-prompt.js"

describe("bounded repository research prompt", () => {
    it("enforces a final multibyte UTF-8 cap and preserves repair plus newest observation", () => {
        const newest = {
            step: 3,
            action: "read",
            output: `LATEST:${"界".repeat(220)}`,
        }
        const prompt = buildBoundedResearchPrompt({
            stableMetadata: ["SESSION ID: session"],
            userGoal: `GOAL:${"界".repeat(2_000)}`,
            bootstrapEvidence: JSON.stringify({
                summary: `BOOTSTRAP:${"界".repeat(2_000)}`,
            }),
            dynamicMetadata: ["CURRENT STEP: 4"],
            observations: [
                { step: 1, output: `old-1:${"x".repeat(400)}` },
                { step: 2, output: `old-2:${"x".repeat(400)}` },
                newest,
            ],
            repairLines: [
                "",
                "PREVIOUS DECISION WAS REJECTED BY BARO VALIDATION:",
                "repair-this-step",
            ],
            finalInstruction: "Choose one action.",
            maximumTranscriptBytes: 4 * 1024,
            maximumStablePrefixBytes: 768,
            maximumBytes: 2 * 1024,
        })

        assert.ok(Buffer.byteLength(prompt, "utf8") <= 2 * 1024)
        assert.match(prompt, /repair-this-step/u)
        assert.ok(prompt.includes(JSON.stringify(newest)))
        assert.match(prompt, /older observation\(s\) omitted/u)
        assert.match(prompt, /clipped by total prompt bound/u)
    })

    it("keeps a substantial stable prefix byte-identical across research steps", () => {
        const newest = {
            step: 1,
            action: "read",
            output: `LATEST-CACHE:${"observation ".repeat(220)}`,
        }
        const stable = {
            stableMetadata: [
                "SESSION ID: session-cache",
                "REQUEST ID: request-cache",
                "CONTEXT REQUEST ID: context-cache",
                "REQUEST INTENT: goal",
            ],
            userGoal: `Inspect the cacheable boundary. ${"goal ".repeat(2_000)}`,
            bootstrapEvidence: JSON.stringify({
                summary: "deterministic bootstrap",
                files: Array.from({ length: 600 }, (_, index) => `src/file-${index}.ts`),
            }),
            finalInstruction: "Choose one action.",
            maximumTranscriptBytes: 4 * 1024,
            maximumStablePrefixBytes: 10 * 1024,
            maximumBytes: 16 * 1024,
        }
        const stepOne = buildBoundedResearchPrompt({
            ...stable,
            dynamicMetadata: ["CURRENT STEP: 1", "CURRENT ATTEMPT: 1"],
            observations: [],
            repairLines: [],
        })
        const stepTwo = buildBoundedResearchPrompt({
            ...stable,
            dynamicMetadata: ["CURRENT STEP: 2", "CURRENT ATTEMPT: 1"],
            observations: [newest],
            repairLines: [
                "",
                "PREVIOUS DECISION WAS REJECTED BY BARO VALIDATION:",
                "cache-repair",
            ],
        })
        const dynamicBoundary = "CURRENT STEP:"
        const stepOnePrefix = stepOne.slice(0, stepOne.indexOf(dynamicBoundary))
        const stepTwoPrefix = stepTwo.slice(0, stepTwo.indexOf(dynamicBoundary))

        assert.equal(stepOnePrefix, stepTwoPrefix)
        assert.ok(Buffer.byteLength(stepOnePrefix, "utf8") > 8 * 1024)
        assert.match(stepOnePrefix, /clipped by total prompt bound/u)
        assert.ok(stepTwo.includes(JSON.stringify(newest)))
        assert.match(stepTwo, /cache-repair/u)
        assert.ok(stepOne.indexOf("BOOTSTRAP EVIDENCE") < stepOne.indexOf(dynamicBoundary))
        assert.ok(stepOne.indexOf(dynamicBoundary) < stepOne.indexOf("PRIOR TOOL OBSERVATIONS"))
    })
})
