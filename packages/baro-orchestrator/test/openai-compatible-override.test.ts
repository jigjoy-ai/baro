import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import { openAICompatibleOverride } from "../src/orchestrate.js"

describe("openAICompatibleOverride", () => {
    it("carries --model to the OpenAI Critic and Surgeon on a compatible endpoint", () => {
        assert.equal(
            openAICompatibleOverride({ overrideModel: "nous/welcome" } as never),
            "nous/welcome",
        )
    })

    it("leaves the defaults alone without --model or with a Claude routing alias", () => {
        assert.equal(openAICompatibleOverride({} as never), undefined)
        assert.equal(openAICompatibleOverride({ overrideModel: null } as never), undefined)
        assert.equal(openAICompatibleOverride({ overrideModel: "opus" } as never), undefined)
        assert.equal(openAICompatibleOverride({ overrideModel: "  " } as never), undefined)
    })
})
