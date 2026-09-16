import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { MILESTONE_TYPES } from "../../src/operator/protocol.js"

/**
 * Whole-set conformance for the awake-clock adoption: every claim here spans
 * files owned by different adopters, so no adopter suite can make it alone.
 * Reads sources only — no child processes, no timers, no sleeping.
 *
 * This file is the gate, not the adoption. The adoption it guards landed in
 * 4e3d256 (the primitive), cb0804c (architect), 6786fd4 (board/conductor),
 * 8338dec (gate/goal-review), 37eec00 (harness) and 21918cb (attribution);
 * a regression in any of them fails here naming the file and line.
 */

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..")
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..")

const VERIFICATION_GATE = "src/verification/verification-goal-gate.ts"
const EXEC_FILE_CLI = "src/harness/exec-file-cli.ts"
const COLLECTIVE_BOARD = "src/execution/collective-board.ts"
const CONDUCTOR = "src/execution/conductor.ts"
const GOAL_REVIEWER = "src/goal/goal-invariant-reviewer.ts"
const ARCHITECT_OPENAI = "src/planning/adapters/architect-openai.ts"

/** Every file the goal names as taking the clock. */
const ADOPTED_SOURCES = [
    ARCHITECT_OPENAI,
    COLLECTIVE_BOARD,
    CONDUCTOR,
    VERIFICATION_GATE,
    GOAL_REVIEWER,
    "src/goal/goal-invariant-review-evidence.ts",
    EXEC_FILE_CLI,
    "src/harness/liveness.ts",
    "src/harness/process-cpu-activity.ts",
    "scripts/run-architect.ts",
] as const

function readPackageFile(relPath: string): string {
    return readFileSync(path.join(PACKAGE_ROOT, relPath), "utf8")
}

/**
 * Assertions below are about code, not prose: several adopted files name
 * `Date.now()` and `setTimeout` in comments precisely to forbid them. Newlines
 * survive so a hit still reports the line number a reader can open.
 */
function stripComments(source: string): string {
    let out = ""
    let mode: "code" | "line" | "block" | "'" | '"' | "`" = "code"
    for (let i = 0; i < source.length; i++) {
        const char = source[i] as string
        const next = source[i + 1]
        if (mode === "code") {
            if (char === "/" && next === "/") {
                mode = "line"
                i++
                continue
            }
            if (char === "/" && next === "*") {
                mode = "block"
                i++
                continue
            }
            if (char === "'" || char === '"' || char === "`") mode = char
            out += char
            continue
        }
        if (mode === "line") {
            if (char === "\n") {
                mode = "code"
                out += char
            }
            continue
        }
        if (mode === "block") {
            if (char === "*" && next === "/") {
                mode = "code"
                i++
                continue
            }
            if (char === "\n") out += char
            continue
        }
        if (char === "\\") {
            out += char + (source[i + 1] ?? "")
            i++
            continue
        }
        if (char === mode) mode = "code"
        out += char
    }
    return out
}

interface Hit {
    readonly file: string
    readonly line: number
    readonly text: string
}

function scan(relPath: string, pattern: RegExp): Hit[] {
    const hits: Hit[] = []
    stripComments(readPackageFile(relPath)).split("\n").forEach((text, index) => {
        if (pattern.test(text)) {
            hits.push({ file: relPath, line: index + 1, text: text.trim() })
        }
    })
    return hits
}

function report(hits: readonly Hit[]): string {
    return hits.map((hit) => `\n  ${hit.file}:${hit.line}  ${hit.text}`).join("")
}

/** The brace-delimited body that follows `header`, so a claim about one
 *  function cannot be satisfied by an unrelated part of the same file. */
function blockAfter(source: string, header: string, label: string): string {
    const start = source.indexOf(header)
    assert.notEqual(start, -1, `${label}: could not find \`${header}\``)
    const open = source.indexOf("{", start)
    assert.notEqual(open, -1, `${label}: no block opens after \`${header}\``)
    let depth = 0
    for (let i = open; i < source.length; i++) {
        if (source[i] === "{") depth += 1
        else if (source[i] === "}") {
            depth -= 1
            if (depth === 0) return source.slice(open, i + 1)
        }
    }
    return assert.fail(`${label}: unbalanced braces after \`${header}\``)
}

function listFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry)
        return statSync(full).isDirectory() ? listFiles(full) : [full]
    })
}

describe("awake-clock adoption conformance", () => {
    describe("kill-capable paths decide expiry by re-reading awake time", () => {
        it("leaves no bare Date.now() in the adopted gate and harness paths", () => {
            const hits = [VERIFICATION_GATE, EXEC_FILE_CLI].flatMap((file) =>
                scan(file, /\bDate\.now\s*\(/u),
            )
            assert.deepEqual(
                hits,
                [],
                `wall time read directly in a kill-capable path; use the injected clock instead:${report(hits)}`,
            )
        })

        it("arms every verification watchdog through a re-arming awake deadline", () => {
            const source = stripComments(readPackageFile(VERIFICATION_GATE))
            const armWatchdog = blockAfter(
                source,
                "private armWatchdog(",
                VERIFICATION_GATE,
            )
            assert.match(
                armWatchdog,
                /createAwakeDeadline\(\{/u,
                `${VERIFICATION_GATE}: armWatchdog must arm an AwakeDeadline, not a one-shot timer`,
            )
            assert.match(
                armWatchdog,
                /clock:\s*this\.clock/u,
                `${VERIFICATION_GATE}: armWatchdog must arm against the injected clock`,
            )
            const timers = scan(VERIFICATION_GATE, /\bsetTimeout\s*\(/u)
            assert.deepEqual(
                timers,
                [],
                `${VERIFICATION_GATE}: a watchdog armed with a raw setTimeout expires on a delay a suspend can absorb:${report(timers)}`,
            )
        })

        it("re-checks and re-arms both exec-file-cli windows before they can kill", () => {
            const source = stripComments(readPackageFile(EXEC_FILE_CLI))
            const credit = blockAfter(
                source,
                "const sleptThroughMs = (",
                EXEC_FILE_CLI,
            )
            assert.match(credit, /clock\.awakeNow\(\)/u)
            assert.match(credit, /clock\.absorbedGapMs\(\)/u)

            for (const [header, rearm] of [
                ["const onCeiling = (): void => {", "timers.setTimeout(onCeiling"],
                ["const onSilence = (): void => {", "timers.setTimeout(onSilence"],
            ] as const) {
                const body = blockAfter(source, header, EXEC_FILE_CLI)
                const creditAt = body.indexOf("sleptThroughMs(")
                assert.notEqual(
                    creditAt,
                    -1,
                    `${EXEC_FILE_CLI}: \`${header}\` must re-read awake time before declaring a timeout`,
                )
                assert.ok(
                    body.includes(rearm),
                    `${EXEC_FILE_CLI}: \`${header}\` must re-arm with the time it slept through, not expire`,
                )
                // Expiry after the credit check is the whole point: a suspend may
                // only postpone the window, never shorten or silently extend it.
                for (const expiry of ["terminate(", "onIdleExpiry("]) {
                    const expiryAt = body.indexOf(expiry)
                    if (expiryAt === -1) continue
                    assert.ok(
                        creditAt < expiryAt,
                        `${EXEC_FILE_CLI}: \`${header}\` reaches \`${expiry}\` before re-checking awake time`,
                    )
                }
            }
        })
    })

    describe("the ExecFileCliTimers seam is untouched", () => {
        const SEAM = `export interface ExecFileCliTimers {
    setTimeout(callback: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
}

const REAL_TIMERS: ExecFileCliTimers = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}`

        it("keeps ExecFileCliTimers and REAL_TIMERS byte-identical", () => {
            assert.ok(
                readPackageFile(EXEC_FILE_CLI).includes(SEAM),
                `${EXEC_FILE_CLI}: the ExecFileCliTimers/REAL_TIMERS block changed; the awake clock is a separate field and must not reshape this seam`,
            )
        })

        it("adds awakeClock beside timers on ExecFileCliOptions", () => {
            const options = blockAfter(
                readPackageFile(EXEC_FILE_CLI),
                "export interface ExecFileCliOptions",
                EXEC_FILE_CLI,
            )
            const timersAt = options.indexOf("timers?: ExecFileCliTimers")
            const clockAt = options.indexOf("awakeClock?: AwakeClock")
            assert.notEqual(timersAt, -1, `${EXEC_FILE_CLI}: timers? left ExecFileCliOptions`)
            assert.notEqual(
                clockAt,
                -1,
                `${EXEC_FILE_CLI}: awakeClock? must be an optional field on ExecFileCliOptions`,
            )
            assert.ok(
                clockAt > timersAt,
                `${EXEC_FILE_CLI}: awakeClock? is expected to sit beside timers?`,
            )
            assert.equal(
                options.slice(timersAt, clockAt).replace(/\/\*[\s\S]*?\*\//gu, "").trim(),
                "timers?: ExecFileCliTimers",
                `${EXEC_FILE_CLI}: only doc comments may separate timers? from awakeClock?`,
            )
        })

        it("keeps both hand-rolled timer fakes free of the awake clock", () => {
            for (const [file, name] of [
                ["test/harness/exec-file-cli.test.ts", "class RecordingClock"],
                ["test/harness/exec-file-cli-cpu-watchdog.test.ts", "class ManualClock"],
            ] as const) {
                const body = blockAfter(readPackageFile(file), name, file)
                assert.match(body, /setTimeout/u, `${file}: ${name} lost its setTimeout member`)
                assert.match(body, /clearTimeout/u, `${file}: ${name} lost its clearTimeout member`)
                assert.doesNotMatch(
                    body,
                    /awake/iu,
                    `${file}: ${name} must keep implementing ExecFileCliTimers alone — the awake clock is injected separately`,
                )
            }
        })
    })

    describe("the clock is injected, never reached for", () => {
        const ENTRY_POINTS = [
            [EXEC_FILE_CLI, "export interface ExecFileCliOptions", "options"],
            [ARCHITECT_OPENAI, "export interface RunArchitectOpenAIOptions", "opts"],
            [COLLECTIVE_BOARD, "export interface CollectiveBoardOptions", "opts"],
            [CONDUCTOR, "export interface ConductorOptions", "opts"],
            [VERIFICATION_GATE, "export interface VerificationGoalGateOptions", "opts"],
        ] as const

        for (const [file, header, bag] of ENTRY_POINTS) {
            it(`offers awakeClock as an optional field on ${header.replace("export interface ", "")}`, () => {
                const options = blockAfter(readPackageFile(file), header, file)
                assert.match(
                    options,
                    /awakeClock\?:\s*AwakeClock/u,
                    `${file}: ${header} must accept the clock optionally, so no existing caller has to change`,
                )
                assert.ok(
                    stripComments(readPackageFile(file)).includes(
                        `${bag}.awakeClock ?? sharedAwakeClock()`,
                    ),
                    `${file}: resolve the clock once as \`${bag}.awakeClock ?? sharedAwakeClock()\``,
                )
            })
        }

        it("acquires the shared singleton only as an injection default", () => {
            // A script's process entry has no caller to inject from; ADR-005
            // puts that one resolution in run-architect's main().
            const PROCESS_ENTRY = "scripts/run-architect.ts"
            const stray: Hit[] = []
            let entryResolutions = 0
            for (const file of ADOPTED_SOURCES) {
                for (const hit of scan(file, /sharedAwakeClock\s*\(/u)) {
                    if (/\bawakeClock\s*\?\?\s*sharedAwakeClock\(\)/u.test(hit.text)) continue
                    if (/:\s*AwakeClock\s*=\s*sharedAwakeClock\(\),?$/u.test(hit.text)) continue
                    if (file === PROCESS_ENTRY) {
                        entryResolutions += 1
                        continue
                    }
                    stray.push(hit)
                }
            }
            assert.deepEqual(
                stray,
                [],
                `the shared clock must be an injection default (\`x.awakeClock ?? sharedAwakeClock()\` or a defaulted parameter), otherwise a test cannot fake it:${report(stray)}`,
            )
            assert.equal(
                entryResolutions,
                1,
                `${PROCESS_ENTRY}: exactly one process-entry resolution is allowed`,
            )
        })
    })

    describe("the fake clock is built per suite, never shared", () => {
        it("keeps no fake-clock helper module under test/", () => {
            const offenders = listFiles(path.join(PACKAGE_ROOT, "test"))
                .filter((full) => !full.endsWith(".test.ts"))
                .filter((full) => /awake|AwakeClock/u.test(readFileSync(full, "utf8")))
                .map((full) => path.relative(PACKAGE_ROOT, full))
            assert.deepEqual(
                offenders,
                [],
                `each suite builds its own fake clock; a shared helper would hide what a subject actually injects:\n  ${offenders.join("\n  ")}`,
            )
        })

        it("has every adopter suite build the fake locally", () => {
            // The harness adopter proves its windows in the dedicated
            // awake-timeout file ADR-010 asks for, not in exec-file-cli.test.ts.
            const SUITES: ReadonlyArray<readonly string[]> = [
                ["test/architect-openai.test.ts"],
                ["test/execution/collective-board.test.ts"],
                ["test/execution/conductor.test.ts"],
                ["test/verification/verification-goal-gate.test.ts"],
                ["test/goal/goal-invariant-reviewer.test.ts"],
                ["test/harness/exec-file-cli-awake-timeout.test.ts", "test/harness/exec-file-cli.test.ts"],
                ["test/harness/process-cpu-activity.test.ts"],
            ]
            const missing = SUITES.filter((candidates) =>
                !candidates.some((file) =>
                    /createFakeAwakeClock/u.test(readPackageFile(file)) &&
                    /from "\.\.?\/.*runtime\/awake-clock\.js"/u.test(readPackageFile(file)),
                ),
            ).map((candidates) => candidates.join(" or "))
            assert.deepEqual(
                missing,
                [],
                `these adopters are not driven by an injected fake clock:\n  ${missing.join("\n  ")}`,
            )
        })
    })

    describe("no adopted deadline rides a single timer delay", () => {
        it("clamps board re-arms with AWAKE_SPLIT_MAX_DELAY_MS, not the platform ceiling", () => {
            for (const file of [COLLECTIVE_BOARD, CONDUCTOR]) {
                const hits = scan(file, /2_147_483_647/u)
                assert.deepEqual(
                    hits,
                    [],
                    `${file}: the platform timer ceiling is replaced by AWAKE_SPLIT_MAX_DELAY_MS:${report(hits)}`,
                )
            }
            const board = stripComments(readPackageFile(COLLECTIVE_BOARD))
            assert.match(
                blockAfter(board, "private armSoftDeadlineTimer(", COLLECTIVE_BOARD),
                /createAwakeDeadline\(\{/u,
                `${COLLECTIVE_BOARD}: the soft deadline must re-arm through an AwakeDeadline`,
            )
            assert.match(
                blockAfter(board, "private scheduleOperationalRetry(", COLLECTIVE_BOARD),
                /AWAKE_SPLIT_MAX_DELAY_MS/u,
                `${COLLECTIVE_BOARD}: operational retries must be clamped to the awake split cap`,
            )
        })

        it("leaves 2_147_483_647 only where it bounds a configured timeout", () => {
            // Rejecting or clamping a caller-supplied timeout is not a timer
            // delay: nothing is armed with this value, so no suspend can absorb it.
            const survivors = [VERIFICATION_GATE, GOAL_REVIEWER].flatMap((file) =>
                scan(file, /2_147_483_647/u),
            )
            const armed = survivors.filter(
                (hit) => !/Math\.min|MAX_TIMER_MS/u.test(hit.text),
            )
            assert.deepEqual(
                armed,
                [],
                `2_147_483_647 may only bound a configured timeout, never an armed delay:${report(armed)}`,
            )
            assert.equal(
                survivors.length,
                2,
                `the surviving configured-timeout bounds changed; re-check each one is still a bound and not a delay:${report(survivors)}`,
            )
        })

        it("expresses the goal-review deadline as an awake deadline", () => {
            const body = blockAfter(
                stripComments(readPackageFile(GOAL_REVIEWER)),
                "function createGoalReviewDeadline(",
                GOAL_REVIEWER,
            )
            assert.match(
                body,
                /createAwakeDeadline\(\{/u,
                `${GOAL_REVIEWER}: createGoalReviewDeadline must abort through an AwakeDeadline`,
            )
            assert.doesNotMatch(
                body,
                /\bsetTimeout\s*\(/u,
                `${GOAL_REVIEWER}: a raw setTimeout here expires on a delay a suspend absorbs`,
            )
            assert.match(
                body,
                /clock\.awakeNow\(\)\s*\+\s*effectiveTimeoutMs/u,
                `${GOAL_REVIEWER}: deadlineAt is an awake timestamp, so it must come from the clock`,
            )
        })

        it("keeps the SoftDeadlineReached payload and wire type unchanged", () => {
            const board = readPackageFile(COLLECTIVE_BOARD)
            assert.ok(
                board.includes(`interface SoftDeadlineReachedData {
    runId: string
    startedAt: number
}`),
                `${COLLECTIVE_BOARD}: the SoftDeadlineReached payload must survive the clock adoption`,
            )
            assert.ok(
                board.includes(`defineSemanticEvent<SoftDeadlineReachedData>(
    "collective_soft_deadline_reached",
)`),
                `${COLLECTIVE_BOARD}: the semantic event type string is replay-visible and must not change`,
            )
            assert.match(
                blockAfter(stripComments(board), "private armSoftDeadlineTimer(", COLLECTIVE_BOARD),
                /SoftDeadlineReached\.create\(\{\s*runId:[^}]*startedAt,\s*\}\)/u,
                `${COLLECTIVE_BOARD}: the emitted payload must stay { runId, startedAt }`,
            )
        })
    })

    describe("the absorbed-gap event stays diagnostic", () => {
        const GAP_TYPE = "suspension_gap_absorbed"

        it("keeps suspension_gap_absorbed out of both MILESTONE_TYPES twins", () => {
            assert.equal(
                MILESTONE_TYPES.has(GAP_TYPE),
                false,
                `src/operator/protocol.ts: ${GAP_TYPE} is diagnostic, not a milestone`,
            )
            const twins = [
                path.join(PACKAGE_ROOT, "src/operator/protocol.ts"),
                path.join(REPO_ROOT, "packages/baro-dsh/src/domain/protocol.ts"),
            ]
            const lists = twins.map((full) => {
                const source = readFileSync(full, "utf8")
                const literal = /MILESTONE_TYPES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/u.exec(source)
                assert.ok(literal, `${full}: could not read the MILESTONE_TYPES literal`)
                return [...literal[1].matchAll(/['"]([^'"]+)['"]/gu)].map((m) => m[1])
            })
            for (const [index, list] of lists.entries()) {
                assert.equal(
                    list.includes(GAP_TYPE),
                    false,
                    `${twins[index]}: ${GAP_TYPE} must not be promoted to a milestone`,
                )
            }
            assert.deepEqual(
                lists[0],
                lists[1],
                "the two MILESTONE_TYPES twins drifted apart",
            )
        })
    })
})
