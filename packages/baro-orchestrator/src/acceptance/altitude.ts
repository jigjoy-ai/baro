/**
 * Pure altitude measurement. This module performs no I/O of its own: diff stats
 * and line counts are supplied by the caller so it stays unit-testable without
 * a repository. Do not add fs, git, process or protocol imports here.
 */

export const ALTITUDE_FILE_LINES = 1500
export const ALTITUDE_GROWTH_LINES = 80

export interface AltitudeDiffStat {
    readonly path: string
    readonly addedLines: number
    readonly removedLines: number
    readonly isNew: boolean
}

export interface AltitudeFinding {
    readonly path: string
    readonly totalLines: number
    readonly addedLines: number
}

export type LineCountReader = (path: string) => number | null

const ADVISORY_SENTENCE =
    "Advisory only: these files are large and grew in this story; do not refactor them unless the goal or decision document explicitly asks for extraction."

const EXEMPT_SEGMENTS = new Set(["test", "tests", "__tests__"])

export function isAltitudeExemptPath(path: string): boolean {
    const segments = path.replace(/^\.\//, "").split("/")
    if (segments.some((segment) => EXEMPT_SEGMENTS.has(segment))) return true
    const basename = segments[segments.length - 1] ?? ""
    return basename.includes(".test.") || basename.includes(".spec.")
}

/** Only accretion onto pre-existing mass counts: new and test files never qualify. */
export function altitudeFindings(
    stats: readonly AltitudeDiffStat[],
    readLineCount: LineCountReader,
): AltitudeFinding[] {
    const findings: AltitudeFinding[] = []
    for (const stat of stats) {
        if (stat.isNew) continue
        if (isAltitudeExemptPath(stat.path)) continue
        const addedLines = normalizeCount(stat.addedLines)
        if (addedLines < ALTITUDE_GROWTH_LINES) continue
        const totalLines = readLineCount(stat.path)
        if (totalLines === null) continue
        if (!Number.isFinite(totalLines)) continue
        if (totalLines < ALTITUDE_FILE_LINES) continue
        findings.push({ path: stat.path, totalLines, addedLines })
    }
    findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return findings.filter(
        (finding, index) =>
            index === 0 || finding.path !== findings[index - 1]!.path,
    )
}

/** `git diff --numstat` records. isNew is always false; the caller fills it in. */
export function parseNumstat(stdout: string): AltitudeDiffStat[] {
    const stats: AltitudeDiffStat[] = []
    for (const line of stdout.split("\n")) {
        if (line.trim() === "") continue
        const fields = line.split("\t")
        if (fields.length < 3) continue
        const added = fields[0]!
        const removed = fields[1]!
        if (added === "-" || removed === "-") continue
        const path = fields.slice(2).join("\t")
        if (path.includes(" => ") || path.includes("{")) continue
        stats.push({
            path,
            addedLines: normalizeCount(Number.parseInt(added, 10)),
            removedLines: normalizeCount(Number.parseInt(removed, 10)),
            isNew: false,
        })
    }
    return stats
}

/** `git diff --name-status` paths that did not exist before: the last field is the destination. */
export function addedPathsFromNameStatus(stdout: string): Set<string> {
    const paths = new Set<string>()
    for (const line of stdout.split("\n")) {
        if (line.trim() === "") continue
        const fields = line.split("\t")
        if (fields.length < 2) continue
        const status = fields[0]!
        if (!status.startsWith("A") && !status.startsWith("C") && !status.startsWith("R")) {
            continue
        }
        const path = fields[fields.length - 1]!
        if (path !== "") paths.add(path)
    }
    return paths
}

/** wc -l style: a trailing line without a newline still counts. */
export function countLines(text: string): number {
    if (text === "") return 0
    let lines = 0
    for (const character of text) {
        if (character === "\n") lines += 1
    }
    return text.endsWith("\n") ? lines : lines + 1
}

export function renderAltitudeEvidenceSection(
    findings: readonly AltitudeFinding[],
): string | null {
    if (findings.length === 0) return null
    const lines = findings.map(
        (finding) =>
            `${finding.path} — ${finding.totalLines} total lines, +${finding.addedLines} this story`,
    )
    return `## Altitude findings (advisory)\n${lines.join("\n")}\n${ADVISORY_SENTENCE}`
}

export function altitudeActivityText(
    findings: readonly AltitudeFinding[],
): string | null {
    if (findings.length === 0) return null
    return findings
        .map(
            (finding) =>
                `altitude: ${finding.path} at ${finding.totalLines} lines grew by ${finding.addedLines}`,
        )
        .join("; ")
}

function normalizeCount(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0
}
