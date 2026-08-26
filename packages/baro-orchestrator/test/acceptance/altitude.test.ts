import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    ALTITUDE_FILE_LINES,
    ALTITUDE_GROWTH_LINES,
    type AltitudeDiffStat,
    addedPathsFromNameStatus,
    altitudeActivityText,
    altitudeFindings,
    countLines,
    isAltitudeExemptPath,
    parseNumstat,
    renderAltitudeEvidenceSection,
} from "../../src/acceptance/altitude.js"

function stat(overrides: Partial<AltitudeDiffStat> = {}): AltitudeDiffStat {
    return {
        path: "src/big.ts",
        addedLines: 80,
        removedLines: 0,
        isNew: false,
        ...overrides,
    }
}

/** A reader that answers from a fixed table; anything else is unknown to the caller. */
function reader(totals: Record<string, number>) {
    return (path: string) => totals[path] ?? null
}

describe("altitude module surface", () => {
    it("exports the two thresholds and the pure helpers", () => {
        assert.equal(ALTITUDE_FILE_LINES, 1500)
        assert.equal(ALTITUDE_GROWTH_LINES, 80)
        assert.equal(typeof isAltitudeExemptPath, "function")
        assert.equal(typeof altitudeFindings, "function")
        assert.equal(typeof parseNumstat, "function")
        assert.equal(typeof addedPathsFromNameStatus, "function")
        assert.equal(typeof countLines, "function")
        assert.equal(typeof renderAltitudeEvidenceSection, "function")
        assert.equal(typeof altitudeActivityText, "function")
    })
})

describe("altitudeFindings thresholds", () => {
    it("reports a file at exactly 1500 lines that gained exactly 80", () => {
        assert.deepEqual(
            altitudeFindings([stat()], reader({ "src/big.ts": 1500 })),
            [{ path: "src/big.ts", totalLines: 1500, addedLines: 80 }],
        )
    })

    it("reports nothing at 1499 total lines", () => {
        assert.deepEqual(
            altitudeFindings([stat()], reader({ "src/big.ts": 1499 })),
            [],
        )
    })

    it("reports nothing for 79 added lines", () => {
        assert.deepEqual(
            altitudeFindings(
                [stat({ addedLines: 79 })],
                reader({ "src/big.ts": 1500 }),
            ),
            [],
        )
    })

    it("treats negative and NaN added counts as zero growth", () => {
        const totals = reader({ "src/big.ts": 5000 })
        assert.deepEqual(altitudeFindings([stat({ addedLines: -900 })], totals), [])
        assert.deepEqual(altitudeFindings([stat({ addedLines: NaN })], totals), [])
    })
})

describe("altitudeFindings exemptions", () => {
    it("exempts test segments and test/spec basenames", () => {
        assert.equal(isAltitudeExemptPath("test/x.ts"), true)
        assert.equal(isAltitudeExemptPath("packages/p/tests/x.ts"), true)
        assert.equal(isAltitudeExemptPath("src/__tests__/x.ts"), true)
        assert.equal(isAltitudeExemptPath("src/foo.test.ts"), true)
        assert.equal(isAltitudeExemptPath("src/foo.spec.ts"), true)
        assert.equal(isAltitudeExemptPath("./test/x.ts"), true)
        assert.equal(isAltitudeExemptPath("src/testing/foo.ts"), false)
        assert.equal(isAltitudeExemptPath("src/foo.ts"), false)
    })

    it("omits exempt paths while an equivalent source file still reports", () => {
        const totals = reader({
            "test/x.ts": 1500,
            "src/foo.test.ts": 1500,
            "src/foo.spec.ts": 1500,
            "src/foo.ts": 1500,
        })
        const findings = altitudeFindings(
            [
                stat({ path: "test/x.ts" }),
                stat({ path: "src/foo.test.ts" }),
                stat({ path: "src/foo.spec.ts" }),
                stat({ path: "src/foo.ts" }),
            ],
            totals,
        )
        assert.deepEqual(findings, [
            { path: "src/foo.ts", totalLines: 1500, addedLines: 80 },
        ])
    })

    it("exempts new files regardless of size", () => {
        assert.deepEqual(
            altitudeFindings(
                [stat({ path: "src/fresh.ts", addedLines: 400, isNew: true })],
                reader({ "src/fresh.ts": 5000 }),
            ),
            [],
        )
    })

    it("skips a path whose line count is unknown to the reader", () => {
        const stats = [stat()]
        assert.deepEqual(altitudeFindings(stats, reader({ "src/big.ts": 1500 })), [
            { path: "src/big.ts", totalLines: 1500, addedLines: 80 },
        ])
        assert.deepEqual(altitudeFindings(stats, () => null), [])
    })
})

describe("altitudeFindings ordering", () => {
    it("orders findings ascending by path independently of input order", () => {
        const totals = reader({ "a.ts": 1600, "m.ts": 1700, "z.ts": 1800 })
        const forward = altitudeFindings(
            [
                stat({ path: "z.ts", addedLines: 100 }),
                stat({ path: "a.ts", addedLines: 90 }),
                stat({ path: "m.ts", addedLines: 95 }),
            ],
            totals,
        )
        const shuffled = altitudeFindings(
            [
                stat({ path: "m.ts", addedLines: 95 }),
                stat({ path: "z.ts", addedLines: 100 }),
                stat({ path: "a.ts", addedLines: 90 }),
            ],
            totals,
        )
        assert.deepEqual(forward, [
            { path: "a.ts", totalLines: 1600, addedLines: 90 },
            { path: "m.ts", totalLines: 1700, addedLines: 95 },
            { path: "z.ts", totalLines: 1800, addedLines: 100 },
        ])
        assert.deepEqual(shuffled, forward)
    })

    it("keeps the first occurrence of a duplicated path", () => {
        assert.deepEqual(
            altitudeFindings(
                [
                    stat({ path: "src/big.ts", addedLines: 120 }),
                    stat({ path: "src/big.ts", addedLines: 300 }),
                ],
                reader({ "src/big.ts": 2000 }),
            ),
            [{ path: "src/big.ts", totalLines: 2000, addedLines: 120 }],
        )
    })

    it("reports only qualifying files from a mixed diff", () => {
        const findings = altitudeFindings(
            [
                stat({ path: "src/zeta.ts", addedLines: 200 }),
                stat({ path: "src/fresh.ts", addedLines: 900, isNew: true }),
                stat({ path: "test/huge.test.ts", addedLines: 900 }),
                stat({ path: "src/small-growth.ts", addedLines: 12 }),
                stat({ path: "src/unknown.ts", addedLines: 400 }),
                stat({ path: "src/alpha.ts", addedLines: 81 }),
                stat({ path: "src/zeta.ts", addedLines: 999 }),
            ],
            reader({
                "src/zeta.ts": 1900,
                "src/fresh.ts": 4000,
                "test/huge.test.ts": 3000,
                "src/small-growth.ts": 9000,
                "src/alpha.ts": 1500,
            }),
        )
        assert.deepEqual(findings, [
            { path: "src/alpha.ts", totalLines: 1500, addedLines: 81 },
            { path: "src/zeta.ts", totalLines: 1900, addedLines: 200 },
        ])
    })

    it("returns an empty array when nothing qualifies", () => {
        assert.deepEqual(altitudeFindings([], () => 5000), [])
    })
})

describe("parseNumstat", () => {
    it("parses added/removed/path records and skips binary and rename lines", () => {
        const stdout = [
            "80\t3\tsrc/big.ts",
            "-\t-\tassets/logo.png",
            "12\t-\tassets/other.bin",
            "40\t0\tsrc/{old => new}/x.ts",
            "40\t0\tsrc/old.ts => src/new.ts",
            "",
            "5\t6\tsrc/small.ts",
        ].join("\n")
        assert.deepEqual(parseNumstat(stdout), [
            { path: "src/big.ts", addedLines: 80, removedLines: 3, isNew: false },
            { path: "src/small.ts", addedLines: 5, removedLines: 6, isNew: false },
        ])
    })

    it("returns an empty array for empty or malformed output", () => {
        assert.deepEqual(parseNumstat(""), [])
        assert.deepEqual(parseNumstat("nonsense line\n"), [])
    })
})

describe("addedPathsFromNameStatus", () => {
    it("collects added, copied and rename destinations", () => {
        const stdout = [
            "A\tsrc/new.ts",
            "M\tsrc/big.ts",
            "D\tsrc/gone.ts",
            "C100\tsrc/source.ts\tsrc/copy.ts",
            "R090\tsrc/from.ts\tsrc/to.ts",
            "",
            "garbage",
        ].join("\n")
        assert.deepEqual(
            [...addedPathsFromNameStatus(stdout)].sort(),
            ["src/copy.ts", "src/new.ts", "src/to.ts"],
        )
    })
})

describe("countLines", () => {
    it("counts wc -l style", () => {
        assert.equal(countLines(""), 0)
        assert.equal(countLines("a"), 1)
        assert.equal(countLines("a\n"), 1)
        assert.equal(countLines("a\nb"), 2)
        assert.equal(countLines("a\nb\n"), 2)
    })
})

describe("renderAltitudeEvidenceSection", () => {
    it("returns null when there are no findings", () => {
        assert.equal(renderAltitudeEvidenceSection([]), null)
    })

    it("renders the advisory heading, one line per finding and the advisory sentence", () => {
        const section = renderAltitudeEvidenceSection([
            { path: "src/alpha.ts", totalLines: 1500, addedLines: 80 },
            { path: "src/zeta.ts", totalLines: 1900, addedLines: 200 },
        ])
        assert.equal(
            section,
            "## Altitude findings (advisory)\n" +
                "src/alpha.ts — 1500 total lines, +80 this story\n" +
                "src/zeta.ts — 1900 total lines, +200 this story\n" +
                "Advisory only: these files are large and grew in this story; do not refactor them unless the goal or decision document explicitly asks for extraction.",
        )
    })
})

describe("altitudeActivityText", () => {
    it("returns null when there are no findings", () => {
        assert.equal(altitudeActivityText([]), null)
    })

    it("renders one line per finding joined with a semicolon", () => {
        assert.equal(
            altitudeActivityText([
                { path: "src/alpha.ts", totalLines: 1500, addedLines: 80 },
            ]),
            "altitude: src/alpha.ts at 1500 lines grew by 80",
        )
        assert.equal(
            altitudeActivityText([
                { path: "src/alpha.ts", totalLines: 1500, addedLines: 80 },
                { path: "src/zeta.ts", totalLines: 1900, addedLines: 200 },
            ]),
            "altitude: src/alpha.ts at 1500 lines grew by 80; altitude: src/zeta.ts at 1900 lines grew by 200",
        )
    })
})
