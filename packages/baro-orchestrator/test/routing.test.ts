import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
    formatRoute,
    isBackend,
    isClaudeTierName,
    parseEndpoints,
    parseTierMap,
    resolveStoryRoute,
    type EndpointMap,
    type ResolveOpts,
} from "../src/routing.js"

const claudeFallback: ResolveOpts = { fallbackBackend: "claude" }
const openaiFallback: ResolveOpts = {
    fallbackBackend: "openai",
    openaiDefaultModel: "gpt-5.5",
}
const codexFallback: ResolveOpts = { fallbackBackend: "codex" }

describe("resolveStoryRoute — bare tier names (back-compat)", () => {
    it("passes a Claude tier through on the Claude backend", () => {
        assert.deepEqual(resolveStoryRoute("sonnet", claudeFallback), {
            backend: "claude",
            model: "sonnet",
        })
        assert.deepEqual(resolveStoryRoute("opus", claudeFallback), {
            backend: "claude",
            model: "opus",
        })
    })

    it("drops a Claude tier name on the OpenAI backend and uses its default", () => {
        // Old behaviour: the OpenAI path ignored the PRD's claude-flavoured
        // model and used openaiModel. Preserve that.
        assert.deepEqual(resolveStoryRoute("opus", openaiFallback), {
            backend: "openai",
            model: "gpt-5.5",
        })
    })

    it("drops a Claude tier name on the Codex backend (Codex picks its own)", () => {
        assert.deepEqual(resolveStoryRoute("haiku", codexFallback), {
            backend: "codex",
        })
    })

    it("passes a real (non-Claude) model name through on OpenAI", () => {
        assert.deepEqual(resolveStoryRoute("gpt-4o", openaiFallback), {
            backend: "openai",
            model: "gpt-4o",
        })
    })

    it("treats an unknown prefix as part of the model name, not a backend", () => {
        assert.deepEqual(resolveStoryRoute("deepseek:chat", openaiFallback), {
            backend: "openai",
            model: "deepseek:chat",
        })
    })
})

describe("resolveStoryRoute — explicit backend:model (all backends)", () => {
    it("routes to the named backend regardless of fallback", () => {
        assert.deepEqual(
            resolveStoryRoute("openai:MiniMax-M3", claudeFallback),
            { backend: "openai", model: "MiniMax-M3" },
        )
        assert.deepEqual(resolveStoryRoute("claude:opus", openaiFallback), {
            backend: "claude",
            model: "opus",
        })
        assert.deepEqual(resolveStoryRoute("codex:gpt-5.5", claudeFallback), {
            backend: "codex",
            model: "gpt-5.5",
        })
    })

    it("a bare backend name selects that backend with its default model", () => {
        assert.deepEqual(resolveStoryRoute("codex", claudeFallback), {
            backend: "codex",
        })
        assert.deepEqual(resolveStoryRoute("openai", claudeFallback), {
            backend: "openai",
            model: undefined,
        })
        assert.deepEqual(
            resolveStoryRoute("openai", {
                fallbackBackend: "claude",
                openaiDefaultModel: "gpt-5.5",
            }),
            { backend: "openai", model: "gpt-5.5" },
        )
    })
})

describe("resolveStoryRoute — empty / default", () => {
    it("empty or undefined resolves to the fallback backend default", () => {
        assert.deepEqual(resolveStoryRoute(undefined, claudeFallback), {
            backend: "claude",
        })
        assert.deepEqual(resolveStoryRoute("", openaiFallback), {
            backend: "openai",
            model: "gpt-5.5",
        })
        assert.deepEqual(resolveStoryRoute("   ", codexFallback), {
            backend: "codex",
        })
    })
})

describe("resolveStoryRoute — tier map (the operator's seniority table)", () => {
    const tierMap = {
        haiku: "openai:MiniMax-M3",
        sonnet: "openai:MiniMax-M3",
        opus: "claude:opus",
    }

    it("expands a bare tier name to its bound backend:model", () => {
        assert.deepEqual(
            resolveStoryRoute("haiku", { ...claudeFallback, tierMap }),
            { backend: "openai", model: "MiniMax-M3" },
        )
        assert.deepEqual(
            resolveStoryRoute("opus", { ...claudeFallback, tierMap }),
            { backend: "claude", model: "opus" },
        )
    })

    it("is case-insensitive on the tier key", () => {
        assert.deepEqual(
            resolveStoryRoute("HAIKU", { ...claudeFallback, tierMap }),
            { backend: "openai", model: "MiniMax-M3" },
        )
    })

    it("an explicit backend:model bypasses the tier map", () => {
        assert.deepEqual(
            resolveStoryRoute("claude:opus", { ...openaiFallback, tierMap }),
            { backend: "claude", model: "opus" },
        )
    })

    it("a tier with no map entry falls back to the phase backend", () => {
        assert.deepEqual(
            resolveStoryRoute("sonnet", {
                ...openaiFallback,
                tierMap: { opus: "claude:opus" },
            }),
            { backend: "openai", model: "gpt-5.5" },
        )
    })
})

describe("resolveStoryRoute — --story-model override", () => {
    it("replaces the per-story route entirely", () => {
        assert.deepEqual(
            resolveStoryRoute("opus", {
                ...claudeFallback,
                override: "openai:MiniMax-M3",
            }),
            { backend: "openai", model: "MiniMax-M3" },
        )
    })

    it("an override that is a bare tier still flows through the tier map", () => {
        assert.deepEqual(
            resolveStoryRoute("opus", {
                ...claudeFallback,
                override: "haiku",
                tierMap: { haiku: "openai:MiniMax-M3" },
            }),
            { backend: "openai", model: "MiniMax-M3" },
        )
    })
})

describe("parseTierMap", () => {
    it("parses a full spec", () => {
        assert.deepEqual(
            parseTierMap(
                "haiku=openai:MiniMax-M3,sonnet=openai:MiniMax-M3,opus=claude:opus",
            ),
            {
                haiku: "openai:MiniMax-M3",
                sonnet: "openai:MiniMax-M3",
                opus: "claude:opus",
            },
        )
    })

    it("lower-cases tier keys and tolerates spaces/trailing commas", () => {
        assert.deepEqual(parseTierMap(" Opus = claude:opus , "), {
            opus: "claude:opus",
        })
    })

    it("accepts a bare backend as a route", () => {
        assert.deepEqual(parseTierMap("haiku=codex"), { haiku: "codex" })
    })

    it("throws when a route names no backend", () => {
        assert.throws(() => parseTierMap("haiku=sonnet"), /must name a backend/)
    })

    it("throws on a malformed entry", () => {
        assert.throws(() => parseTierMap("haiku"), /expected tier=backend:model/)
        assert.throws(() => parseTierMap("=claude:opus"), /expected tier=backend:model/)
    })
})

describe("resolveStoryRoute — per-story OpenAI endpoint (@)", () => {
    const endpoints: EndpointMap = {
        minimax: { baseUrl: "https://api.minimax.io/v1", apiKey: "mm-key" },
        proxy: { baseUrl: "https://proxy.local/v1" }, // no key of its own
    }

    it("resolves a named endpoint to baseUrl + apiKey", () => {
        assert.deepEqual(
            resolveStoryRoute("openai:MiniMax-M3@minimax", {
                fallbackBackend: "claude",
                endpoints,
            }),
            {
                backend: "openai",
                model: "MiniMax-M3",
                baseUrl: "https://api.minimax.io/v1",
                apiKey: "mm-key",
            },
        )
    })

    it("falls back to defaultApiKey when the endpoint carries no key", () => {
        assert.deepEqual(
            resolveStoryRoute("openai:gpt-4o@proxy", {
                fallbackBackend: "claude",
                endpoints,
                defaultApiKey: "env-key",
            }),
            {
                backend: "openai",
                model: "gpt-4o",
                baseUrl: "https://proxy.local/v1",
                apiKey: "env-key",
            },
        )
    })

    it("accepts an inline https:// URL with the default key", () => {
        assert.deepEqual(
            resolveStoryRoute("openai:MiniMax-M3@https://api.minimax.io/v1", {
                fallbackBackend: "claude",
                defaultApiKey: "env-key",
            }),
            {
                backend: "openai",
                model: "MiniMax-M3",
                baseUrl: "https://api.minimax.io/v1",
                apiKey: "env-key",
            },
        )
    })

    it("expands a tier-map route that references an endpoint", () => {
        assert.deepEqual(
            resolveStoryRoute("haiku", {
                fallbackBackend: "claude",
                tierMap: { haiku: "openai:MiniMax-M3@minimax" },
                endpoints,
            }),
            {
                backend: "openai",
                model: "MiniMax-M3",
                baseUrl: "https://api.minimax.io/v1",
                apiKey: "mm-key",
            },
        )
    })

    it("throws on an unknown endpoint name", () => {
        assert.throws(
            () =>
                resolveStoryRoute("openai:MiniMax-M3@nope", {
                    fallbackBackend: "claude",
                    endpoints,
                }),
            /unknown OpenAI endpoint "nope"/,
        )
    })

    it("ignores @ on claude/codex routes (no endpoint concept)", () => {
        assert.deepEqual(
            resolveStoryRoute("claude:opus@whatever", { fallbackBackend: "openai" }),
            { backend: "claude", model: "opus@whatever" },
        )
    })
})

describe("parseEndpoints", () => {
    it("parses name=url specs and resolves keys via the callback", () => {
        const map = parseEndpoints(
            ["minimax=https://api.minimax.io/v1", "OpenAI=https://api.openai.com/v1"],
            (name) => (name === "minimax" ? "mm-key" : undefined),
        )
        assert.deepEqual(map, {
            minimax: { baseUrl: "https://api.minimax.io/v1", apiKey: "mm-key" },
            openai: { baseUrl: "https://api.openai.com/v1", apiKey: undefined },
        })
    })

    it("throws on a non-URL value", () => {
        assert.throws(
            () => parseEndpoints(["minimax=api.minimax.io"]),
            /must start with http/,
        )
    })

    it("throws on a malformed spec", () => {
        assert.throws(() => parseEndpoints(["minimax"]), /expected name=url/)
    })
})

describe("helpers", () => {
    it("isBackend", () => {
        assert.equal(isBackend("claude"), true)
        assert.equal(isBackend("openai"), true)
        assert.equal(isBackend("codex"), true)
        assert.equal(isBackend("gemini"), false)
    })

    it("isClaudeTierName", () => {
        assert.equal(isClaudeTierName("opus"), true)
        assert.equal(isClaudeTierName("sonnet-4-6"), true)
        assert.equal(isClaudeTierName("MiniMax-M3"), false)
        assert.equal(isClaudeTierName("gpt-5.5"), false)
    })

    it("formatRoute", () => {
        assert.equal(formatRoute({ backend: "openai", model: "MiniMax-M3" }), "openai:MiniMax-M3")
        assert.equal(formatRoute({ backend: "codex" }), "codex")
        assert.equal(
            formatRoute({ backend: "openai", model: "MiniMax-M3", baseUrl: "https://api.minimax.io/v1" }),
            "openai:MiniMax-M3@https://api.minimax.io/v1",
        )
    })
})

describe("resolveStoryRoute — cheap-by-default + Surgeon escalation route (cloud jigjoy)", () => {
    // The hosted-gateway tier map: EVERY planner tier maps to the cheap model.
    // The planner's blast-radius tier does NOT pick the story model — stories
    // run cheap by default and only reach the strong model through an explicit
    // escalation route the Surgeon sets on a stuck story.
    const jigjoy: ResolveOpts = {
        fallbackBackend: "openai",
        openaiDefaultModel: "gpt-5.5",
        tierMap: {
            default: "openai:deepseek-chat",
            haiku: "openai:deepseek-chat",
            sonnet: "openai:deepseek-chat",
            opus: "openai:deepseek-chat",
        },
    }
    it("routes an un-tiered story to the cheap default (NOT the openai default)", () => {
        assert.deepEqual(resolveStoryRoute(undefined, jigjoy), { backend: "openai", model: "deepseek-chat" })
        assert.deepEqual(resolveStoryRoute("", jigjoy), { backend: "openai", model: "deepseek-chat" })
    })
    it("keeps EVERY planner tier — including opus — on the cheap model", () => {
        assert.deepEqual(resolveStoryRoute("haiku", jigjoy), { backend: "openai", model: "deepseek-chat" })
        assert.deepEqual(resolveStoryRoute("sonnet", jigjoy), { backend: "openai", model: "deepseek-chat" })
        assert.deepEqual(resolveStoryRoute("opus", jigjoy), { backend: "openai", model: "deepseek-chat" })
    })
    it("runs the Surgeon's explicit escalation route on the strong model (bypasses the cheap tier map)", () => {
        assert.deepEqual(resolveStoryRoute("openai:gpt-5.5", jigjoy), { backend: "openai", model: "gpt-5.5" })
    })
})
