/**
 * Classify tool output as a test-run verdict: `true` = passed, `false` =
 * failed, `null` = not a test result (caller renders a plain line, no ✓/✗).
 *
 * Display-only heuristic over arbitrary shell output, so it never guesses:
 * a wrong ✗ on a green run is worse than no verdict at all.
 *
 * Counts are extracted, not keyword-matched, because green runs often state
 * their zero failures — "fail 0" (node:test), "0 failed" (cargo), "0
 * failures" (RSpec) — and the number appears on either side of the keyword.
 *
 * Rules, in order:
 *   1. a failure count > 0             → failed
 *   2. bare "FAIL" and no counts       → failed  (go test, jest file headers;
 *                                                 beats pass lines in mixed output)
 *   3. a pass count > 0                → passed
 *   4. "tests pass(ed)" / "N tests ok" → passed
 *   5. all stated failure counts are 0 → passed  ("12 examples, 0 failures")
 *   6. otherwise                       → null
 */
export function testVerdict(out: string): boolean | null {
    const s = out.toLowerCase()
    const failCounts = extractCounts(
        s,
        /\b(\d+)\s+fail(?:ed|ing|ures?)?\b/g,
        /\bfail(?:ed|ing|ures?)?:?\s+(\d+)\b/g,
    )
    const passCounts = extractCounts(
        s,
        /\b(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b/g,
        /\bpass(?:ed|ing)?:?\s+(\d+)\b/g,
    )

    if (failCounts.some((n) => n > 0)) return false
    if (failCounts.length === 0 && /(^|\s)fail\b/.test(s)) return false
    if (passCounts.some((n) => n > 0)) return true
    if (/\b\d+\s+tests?\s+ok\b/.test(s) || /\btests?\s+pass(?:ed)?\b/.test(s)) return true
    if (failCounts.length > 0) return true
    return null
}

/** All numbers captured by the given patterns' first capture group. */
function extractCounts(s: string, ...patterns: RegExp[]): number[] {
    const counts: number[] = []
    for (const p of patterns) {
        for (const m of s.matchAll(p)) counts.push(Number(m[1]))
    }
    return counts
}
