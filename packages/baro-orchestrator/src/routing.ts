/**
 * Per-story model routing — the single source of truth for deciding,
 * for one story, WHICH backend runs it and WITH WHICH model.
 *
 * Background. Before this module, baro tiered models only by *phase*
 * (`--story-llm` / `--critic-llm` / `--surgeon-llm`): every story in a
 * run shared one backend and one model. The PRD already carried a
 * per-story `model` field, but it only meaningfully reached the Claude
 * path (opus/sonnet/haiku) and the OpenAI/Codex paths ignored it.
 *
 * This module makes the per-story `model` field a full **route** that
 * works for ALL THREE backends (claude / openai / codex), so a single
 * DAG can mix them — e.g. cheap single-concern stories on a local
 * OpenAI-compatible model and cross-cutting stories on Claude Opus.
 *
 * Two layers:
 *   1. A route string may be a bare tier/model name ("opus", "sonnet",
 *      "haiku", "gpt-5.5") or an explicit `backend:model`
 *      ("claude:opus", "openai:MiniMax-M3", "codex", "codex:gpt-5.5").
 *   2. A TierMap binds semantic tier names emitted by the Planner
 *      (the "blast-radius" classification — haiku/sonnet/opus) to
 *      concrete `backend:model` routes. This decouples "how risky is
 *      this story" (the Planner's job) from "which model serves that
 *      tier" (the operator's job) — exactly a team's seniority table.
 *
 * Back-compat: with no TierMap and a bare tier name, resolution returns
 * the same backend/model the old phase-level wiring produced.
 */

export type Backend = "claude" | "openai" | "codex"

const BACKENDS: readonly Backend[] = ["claude", "openai", "codex"]

export function isBackend(s: string): s is Backend {
    return (BACKENDS as readonly string[]).includes(s)
}

/** The resolved decision for one story: which backend, which model. */
export interface StoryRoute {
    backend: Backend
    /**
     * Model name in the backend's own nomenclature. `undefined` means
     * "let the backend / agent apply its own default" (Claude → opus,
     * Codex → account default).
     */
    model?: string
}

/**
 * Maps a semantic tier name (lower-cased, e.g. "haiku" | "sonnet" |
 * "opus", but any token the Planner emits is allowed) to a concrete
 * `backend:model` route string. Every value MUST name a backend.
 */
export type TierMap = Record<string, string>

// Claude tier names ("opus"/"sonnet"/"haiku", optionally with a date
// suffix like "sonnet-4-6") are meaningless to the OpenAI / Codex
// backends, so when a bare Claude tier name lands on a non-Claude
// backend we drop it and use that backend's own default model instead.
const CLAUDE_TIER_RE = /^(opus|sonnet|haiku)\b/i

export function isClaudeTierName(s: string): boolean {
    return CLAUDE_TIER_RE.test(s.trim())
}

/**
 * Split a route token into `{ backend?, model? }`.
 *   "openai:MiniMax-M3" → { backend: "openai", model: "MiniMax-M3" }
 *   "codex"             → { backend: "codex" }
 *   "opus"              → { model: "opus" }            (bare tier/model)
 * A `prefix:` is only treated as a backend when it is a known backend;
 * "deepseek:chat" → { model: "deepseek:chat" } (no known backend).
 */
function splitBackendModel(raw: string): { backend?: Backend; model?: string } {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    const idx = trimmed.indexOf(":")
    if (idx > 0) {
        const prefix = trimmed.slice(0, idx).toLowerCase()
        if (isBackend(prefix)) {
            const model = trimmed.slice(idx + 1).trim()
            return { backend: prefix, model: model.length ? model : undefined }
        }
    }
    if (isBackend(trimmed.toLowerCase())) {
        return { backend: trimmed.toLowerCase() as Backend }
    }
    return { model: trimmed }
}

export interface ResolveOpts {
    /** Tier→route bindings. Bare names not present here are not expanded. */
    tierMap?: TierMap
    /** Backend used when a route names no backend of its own. */
    fallbackBackend: Backend
    /** Default model for the OpenAI backend (from `--story-model` / "gpt-5.5"). */
    openaiDefaultModel?: string
    /**
     * Global `--story-model` override. When set it REPLACES the per-story
     * route entirely (but still flows through tier-map + backend parsing,
     * so `--story-model openai:MiniMax-M3` and `--story-model haiku` both
     * work).
     */
    override?: string
}

/**
 * Resolve one story's route. Pure function — same inputs, same output.
 */
export function resolveStoryRoute(
    rawModel: string | undefined,
    opts: ResolveOpts,
): StoryRoute {
    const raw = (opts.override ?? rawModel ?? "").trim()

    // Empty → the fallback backend's own default.
    if (!raw) return defaultRoute(opts.fallbackBackend, opts.openaiDefaultModel)

    const direct = splitBackendModel(raw)

    // Tier-map expansion: a bare tier/model name (no explicit backend)
    // with a map entry expands to its concrete route. An explicit
    // `backend:model` bypasses the map. Recurse with the map removed so
    // the mapped value (which names a backend) is parsed directly and
    // can never re-expand into a loop.
    if (direct.backend === undefined && opts.tierMap) {
        const mapped = opts.tierMap[raw.toLowerCase()] ?? opts.tierMap[raw]
        if (mapped) {
            return resolveStoryRoute(mapped, {
                ...opts,
                override: undefined,
                tierMap: undefined,
            })
        }
    }

    // Explicit backend chosen.
    if (direct.backend) {
        if (direct.model) return { backend: direct.backend, model: direct.model }
        return defaultRoute(direct.backend, opts.openaiDefaultModel)
    }

    // Bare model/tier name, no map entry → runs on the fallback backend.
    const backend = opts.fallbackBackend
    if (backend === "claude") {
        return { backend, model: direct.model }
    }
    // Non-Claude backends: a Claude tier name is meaningless, so fall
    // back to the backend's default model; a real model name passes
    // through.
    if (direct.model && !isClaudeTierName(direct.model)) {
        return { backend, model: direct.model }
    }
    return defaultRoute(backend, opts.openaiDefaultModel)
}

function defaultRoute(backend: Backend, openaiDefaultModel?: string): StoryRoute {
    if (backend === "openai") return { backend, model: openaiDefaultModel }
    // Claude → StoryAgent applies its own default ("opus").
    // Codex → its own account default.
    return { backend }
}

/**
 * Parse a `--tier-map` spec: comma-separated `tier=backend:model`
 * entries, e.g. `"haiku=openai:MiniMax-M3,sonnet=openai:MiniMax-M3,opus=claude:opus"`.
 * Every route value must name a backend — that is the whole point of the
 * map (binding a semantic tier to a concrete backend). Throws on a
 * malformed entry so a typo fails loudly at startup instead of silently
 * routing everything to the fallback.
 */
export function parseTierMap(spec: string): TierMap {
    const map: TierMap = {}
    for (const part of spec.split(",")) {
        const seg = part.trim()
        if (!seg) continue
        const eq = seg.indexOf("=")
        if (eq <= 0) {
            throw new Error(
                `bad --tier-map entry "${seg}" (expected tier=backend:model)`,
            )
        }
        const tier = seg.slice(0, eq).trim().toLowerCase()
        const route = seg.slice(eq + 1).trim()
        if (!tier || !route) {
            throw new Error(
                `bad --tier-map entry "${seg}" (expected tier=backend:model)`,
            )
        }
        const { backend } = splitBackendModel(route)
        if (!backend) {
            throw new Error(
                `--tier-map route "${route}" for tier "${tier}" must name a backend ` +
                    `(claude: | openai: | codex:)`,
            )
        }
        map[tier] = route
    }
    return map
}

/** Human-readable one-liner for banners / logs. */
export function formatRoute(route: StoryRoute): string {
    return route.model ? `${route.backend}:${route.model}` : route.backend
}
