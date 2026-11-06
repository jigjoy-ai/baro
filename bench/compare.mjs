#!/usr/bin/env node
// Compares two benchmark summaries. Exits 1 when the candidate regresses:
// a case that passed now fails, or its wall time or cost grew past the threshold.
//
//   node bench/compare.mjs bench/results/v0.122.1/summary.json bench/results/local/summary.json [--threshold 0.15]

import { readFileSync } from "node:fs"

const args = process.argv.slice(2)
const ti = args.indexOf("--threshold")
const threshold = ti >= 0 ? Number(args.splice(ti, 2)[1]) : 0.15
const [basePath, candPath] = args
if (!basePath || !candPath) {
    console.error("usage: node bench/compare.mjs <base summary.json> <candidate summary.json> [--threshold 0.15]")
    process.exit(2)
}
const base = JSON.parse(readFileSync(basePath, "utf8"))
const cand = JSON.parse(readFileSync(candPath, "utf8"))

const pct = (a, b) => (a && b != null ? (b - a) / a : null)
const show = (a, b, digits = 0) => {
    const p = pct(a, b)
    const v = b == null ? "-" : Number(b).toFixed(digits)
    return p == null ? v : `${v} (${p >= 0 ? "+" : ""}${Math.round(p * 100)}%)`
}

const rows = []
const regressions = []
for (const id of Object.keys(cand.cases)) {
    const b = base.cases[id]
    const c = cand.cases[id]
    if (!b) {
        rows.push([id, c.success ? "ok" : "FAIL", "new case", "", "", "", ""])
        continue
    }
    rows.push([
        id,
        `${b.success ? "ok" : "FAIL"} -> ${c.success ? "ok" : "FAIL"}`,
        show(b.wall_secs, c.wall_secs),
        show(b.to_first_story_secs, c.to_first_story_secs),
        show(b.stories_secs, c.stories_secs),
        show(b.cost_usd, c.cost_usd, 2),
        `${b.story_count} -> ${c.story_count}`,
    ])
    if (b.success && !c.success) regressions.push(`${id}: passed in ${base.label}, fails in ${cand.label}`)
    if (c.success && pct(b.wall_secs, c.wall_secs) > threshold) regressions.push(`${id}: wall time ${show(b.wall_secs, c.wall_secs)}`)
    if (c.success && pct(b.cost_usd, c.cost_usd) > threshold) regressions.push(`${id}: cost ${show(b.cost_usd, c.cost_usd, 2)}`)
}

const header = ["case", "result", "wall s", "to 1st story s", "stories s", "cost $", "stories"]
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
const line = (r) => r.map((x, i) => String(x).padEnd(widths[i])).join("  ")
console.log(`${base.label} -> ${cand.label}\n`)
console.log(line(header))
for (const r of rows) console.log(line(r))
if (regressions.length) {
    console.log(`\nRegressions (threshold ${Math.round(threshold * 100)}%):`)
    for (const r of regressions) console.log(`- ${r}`)
    process.exit(1)
}
console.log("\nNo regressions.")
