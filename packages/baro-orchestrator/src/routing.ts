/**
 * Per-story model routing: which backend and model run one story, so a
 * single DAG can mix backends. A route is a bare tier/model name or an
 * explicit `backend:model`; a TierMap binds the Planner's semantic tiers
 * (haiku/sonnet/opus) to concrete routes. Back-compat: with no TierMap, a
 * bare tier name resolves as the old phase-level wiring did.
 */

export type Backend = "claude" | "openai" | "codex" | "opencode" | "pi"

const BACKENDS: readonly Backend[] = ["claude", "openai", "codex", "opencode", "pi"]

export function isBackend(s: string): s is Backend {
    return (BACKENDS as readonly string[]).includes(s)
}

export interface StoryRoute {
    backend: Backend
    /**
     * Model name in the backend's own nomenclature; `undefined` → the
     * backend's own default (Claude → opus, Codex → account default).
     */
    model?: string
    /**
     * Endpoint base URL for THIS story; only set on `openai` routes that
     * named one (`openai:model@name|url`). `undefined` → the process-global
     * `OPENAI_BASE_URL`. Lets one DAG hit several endpoints at once.
     */
    baseUrl?: string
    /** API key paired with `baseUrl`. Resolved from the endpoint registry. */
    apiKey?: string
}

/**
 * Named OpenAI-compatible endpoint. Built by the CLI, which resolves keys
 * from the environment so secrets never travel on the command line.
 */
export interface Endpoint {
    baseUrl: string
    apiKey?: string
}

/** name → endpoint. Names are matched case-insensitively. */
export type EndpointMap = Record<string, Endpoint>

/**
 * Lower-cased tier name (any token the Planner emits) → `backend:model`
 * route. Every value MUST name a backend.
 */
export type TierMap = Record<string, string>

// Claude tier names (optionally date-suffixed, e.g. "sonnet-4-6") are
// meaningless to non-Claude backends, which fall back to their own default.
const CLAUDE_TIER_RE = /^(opus|sonnet|haiku)\b/i

export function isClaudeTierName(s: string): boolean {
    return CLAUDE_TIER_RE.test(s.trim())
}

/**
 * Split a route token into `{ backend?, model? }`. A `prefix:` is only a
 * backend when it names a known one — "deepseek:chat" stays a bare model.
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
    /** Default model for the OpenAI backend. */
    openaiDefaultModel?: string
    /**
     * Global `--story-model` override: REPLACES the per-story route
     * entirely, but still flows through tier-map + backend parsing.
     */
    override?: string
    /**
     * Named endpoints for `openai:model@name` routes. An `@` reference that
     * looks like a URL is used inline instead of being looked up here.
     */
    endpoints?: EndpointMap
    /**
     * API key for inline URL endpoints and named endpoints without their
     * own key. Usually `OPENAI_API_KEY`.
     */
    defaultApiKey?: string
}

function looksLikeUrl(s: string): boolean {
    return /^https?:\/\//i.test(s.trim())
}

function splitModelEndpoint(model: string): { model: string; endpointRef?: string } {
    const at = model.indexOf("@")
    if (at < 0) return { model }
    const ref = model.slice(at + 1).trim()
    return { model: model.slice(0, at).trim(), endpointRef: ref || undefined }
}

/**
 * A URL ref is used as-is; a bare name is looked up. Throws on an unknown
 * name so a typo fails loudly instead of silently hitting the default
 * endpoint.
 */
function resolveEndpoint(ref: string, opts: ResolveOpts): Endpoint {
    if (looksLikeUrl(ref)) {
        return { baseUrl: ref, apiKey: opts.defaultApiKey }
    }
    const ep = opts.endpoints?.[ref.toLowerCase()] ?? opts.endpoints?.[ref]
    if (!ep) {
        throw new Error(
            `unknown OpenAI endpoint "${ref}" — define it with ` +
                `--openai-endpoint ${ref}=<url> or use an inline https:// URL`,
        )
    }
    return { baseUrl: ep.baseUrl, apiKey: ep.apiKey ?? opts.defaultApiKey }
}

/** Resolve one story's route. Pure function. */
export function resolveStoryRoute(
    rawModel: string | undefined,
    opts: ResolveOpts,
): StoryRoute {
    const raw = (opts.override ?? rawModel ?? "").trim()

    // Empty → the tier map's "default"/"*" entry if set, else the fallback
    // backend's default. The map entry routes un-tiered stories cheap without
    // a --story-model override (which would block per-story escalation).
    if (!raw) {
        const dflt = opts.tierMap?.["default"] ?? opts.tierMap?.["*"]
        if (dflt) {
            return resolveStoryRoute(dflt, { ...opts, override: undefined, tierMap: undefined })
        }
        return defaultRoute(opts.fallbackBackend, opts.openaiDefaultModel)
    }

    const direct = splitBackendModel(raw)

    // Bare names expand through the tier map; explicit `backend:model`
    // bypasses it. Recurse with the map removed so the mapped value can
    // never re-expand into a loop.
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

    if (direct.backend) {
        if (direct.model) return buildRoute(direct.backend, direct.model, opts)
        return defaultRoute(direct.backend, opts.openaiDefaultModel)
    }

    const backend = opts.fallbackBackend
    if (backend === "claude") {
        return { backend, model: direct.model }
    }
    // A Claude tier name is meaningless on a non-Claude backend → its
    // default model; a real model name passes through.
    if (direct.model && !isClaudeTierName(direct.model)) {
        return buildRoute(backend, direct.model, opts)
    }
    return defaultRoute(backend, opts.openaiDefaultModel)
}

/**
 * For `openai`, an `@endpoint` suffix on the model is split off and
 * resolved; other backends have no endpoint concept and ignore any `@`.
 */
function buildRoute(backend: Backend, model: string, opts: ResolveOpts): StoryRoute {
    if (backend !== "openai") return { backend, model }
    const { model: bareModel, endpointRef } = splitModelEndpoint(model)
    if (!endpointRef) return { backend, model: bareModel }
    const ep = resolveEndpoint(endpointRef, opts)
    return { backend, model: bareModel, baseUrl: ep.baseUrl, apiKey: ep.apiKey }
}

function defaultRoute(backend: Backend, openaiDefaultModel?: string): StoryRoute {
    if (backend === "openai") return { backend, model: openaiDefaultModel }
    return { backend }
}

/**
 * Parse `--tier-map`: comma-separated `tier=backend:model` entries. Every
 * route must name a backend; throws on a malformed entry so a typo fails
 * at startup instead of silently routing everything to the fallback.
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
                    `(claude: | openai: | codex: | opencode: | pi:)`,
            )
        }
        map[tier] = route
    }
    return map
}

/**
 * Parse `--openai-endpoint name=url` specs. `keyFor(name)` supplies API
 * keys (resolved from the environment so secrets stay off the command
 * line); names are lower-cased for case-insensitive lookup. Throws on a
 * malformed spec or non-URL value.
 */
export function parseEndpoints(
    specs: readonly string[],
    keyFor?: (name: string) => string | undefined,
): EndpointMap {
    const map: EndpointMap = {}
    for (const raw of specs) {
        const spec = raw.trim()
        if (!spec) continue
        const eq = spec.indexOf("=")
        if (eq <= 0) {
            throw new Error(
                `bad --openai-endpoint "${spec}" (expected name=url)`,
            )
        }
        const name = spec.slice(0, eq).trim().toLowerCase()
        const url = spec.slice(eq + 1).trim()
        if (!name || !url) {
            throw new Error(
                `bad --openai-endpoint "${spec}" (expected name=url)`,
            )
        }
        if (!looksLikeUrl(url)) {
            throw new Error(
                `--openai-endpoint "${name}" url "${url}" must start with http:// or https://`,
            )
        }
        map[name] = { baseUrl: url, apiKey: keyFor?.(name) }
    }
    return map
}

/** Human-readable one-liner for banners / logs. */
export function formatRoute(route: StoryRoute): string {
    const base = route.model ? `${route.backend}:${route.model}` : route.backend
    return route.baseUrl ? `${base}@${route.baseUrl}` : base
}
