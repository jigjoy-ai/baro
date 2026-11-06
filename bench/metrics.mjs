// Run metrics derived only from Baro's headless event stream (docs/tui-protocol-v3.md),
// so any recorded run, old or new, can be measured the same way.

export function parseStream(text) {
    const events = []
    for (const line of text.split("\n")) {
        if (!line.startsWith("{")) continue
        try {
            events.push(JSON.parse(line))
        } catch {}
    }
    return events
}

const ms = (e) => Date.parse(e.ts)
const secs = (a, b) => (a == null || b == null ? null : Math.round((b - a) / 100) / 10)
const known = (field) => (field && field.state === "known" ? field.value : 0)

export function metrics(events, { startedAt = null } = {}) {
    const timed = events.filter((e) => typeof e.ts === "string")
    const t0 = startedAt ?? (timed.length ? ms(timed[0]) : null)
    const first = (type) => timed.find((e) => e.type === type)
    const done = [...timed].reverse().find((e) => e.type === "done")

    const stories = new Map()
    const story = (id) => {
        if (!stories.has(id)) stories.set(id, { id, start: null, end: null, attempts: 0, reviews: 0, cost_usd: 0 })
        return stories.get(id)
    }
    let retries = 0
    let replans = 0
    const reviews = { total: 0, rejected: 0, stale_evidence: 0 }
    for (const e of timed) {
        if (e.type === "story_start") {
            const s = story(e.id)
            s.attempts += 1
            s.start ??= ms(e)
        } else if (e.type === "story_merged" || (e.type === "story_complete" && !story(e.id).end)) {
            story(e.id).end = ms(e)
        } else if (e.type === "story_retry") {
            retries += 1
        } else if (e.type === "replan") {
            replans += 1
        } else if (e.type === "turn_review") {
            reviews.total += 1
            story(e.id).reviews += 1
            if (e.stale_commands?.length) reviews.stale_evidence += 1
            else if (e.verdict === "fail") reviews.rejected += 1
        }
    }

    const phases = {}
    const tokens = { input: 0, cached_input: 0, cache_write: 0, output: 0 }
    let cost = 0
    for (const e of events) {
        if (e.type !== "model_usage" || !e.measurement) continue
        const m = e.measurement
        const usd = known(m.cost?.equivalentUsd) || known(m.cost?.providerUsd)
        cost += usd
        tokens.input += known(m.tokens?.inputTotal)
        tokens.cached_input += known(m.tokens?.cachedInput)
        tokens.cache_write += known(m.tokens?.cacheWriteInput)
        tokens.output += known(m.tokens?.outputTotal)
        const p = (phases[m.phase ?? "unknown"] ??= { calls: 0, cost_usd: 0, model_secs: 0 })
        p.calls += 1
        p.cost_usd += usd
        p.model_secs += known(m.durationMs) / 1000
        if (m.storyId) story(m.storyId).cost_usd += usd
    }

    const list = [...stories.values()].filter((s) => s.start != null)
    const starts = list.map((s) => s.start)
    const ends = list.map((s) => s.end).filter((x) => x != null)
    const firstStory = starts.length ? Math.min(...starts) : null
    const lastStory = ends.length ? Math.max(...ends) : null
    const round = (x) => Math.round(x * 10000) / 10000

    return {
        success: done?.success === true,
        verification: done?.verification_status ?? null,
        abort_reason: done?.abort_reason ?? null,
        total_secs: secs(t0, done ? ms(done) : timed.length ? ms(timed.at(-1)) : null),
        architect_secs: secs(first("architect_start") && ms(first("architect_start")), first("architect_complete") && ms(first("architect_complete"))),
        to_first_story_secs: secs(t0, firstStory),
        stories_secs: secs(firstStory, lastStory),
        finalize_secs: secs(lastStory, done ? ms(done) : null),
        story_count: list.length,
        retries,
        replans,
        // Present only for builds that emit turn_review (after 0.122.1).
        critic_reviews: reviews.total ? reviews : null,
        cost_usd: round(cost),
        tokens,
        cache_hit_ratio: tokens.input ? round(tokens.cached_input / tokens.input) : null,
        phases: Object.fromEntries(
            Object.entries(phases).map(([k, v]) => [k, { calls: v.calls, cost_usd: round(v.cost_usd), model_secs: Math.round(v.model_secs) }]),
        ),
        stories: list.map((s) => ({
            id: s.id,
            secs: secs(s.start, s.end),
            attempts: s.attempts,
            reviews: s.reviews,
            cost_usd: round(s.cost_usd),
        })),
    }
}
