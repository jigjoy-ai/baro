export interface ArchitectureDecisionRecord {
    readonly id: string
    readonly ordinal: number
    readonly title: string
    readonly status: "Accepted"
    readonly context: string
    readonly decision: string
    readonly consequences: string
}

export interface ArchitectureDecisionDocument {
    readonly decisions: readonly ArchitectureDecisionRecord[]
    readonly hasExistingContext: boolean
}

export class ArchitectureDecisionDocumentError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ArchitectureDecisionDocumentError"
    }
}

interface VisibleLine {
    readonly text: string
    readonly lineNumber: number
}

interface DecisionHeading {
    readonly id: string
    readonly ordinal: number
    readonly title: string
    readonly lineIndex: number
}

type RequiredField = "Status" | "Context" | "Decision" | "Consequences"

const ADR_HEADING = /^ {0,3}##[ \t]+(ADR-(\d{3})):[ \t]+(.+?)[ \t]*$/u
const LEVEL_TWO_HEADING = /^ {0,3}##(?:[ \t]+|$)/u
const EXISTING_CONTEXT_HEADING = /^ {0,3}##[ \t]+Existing context[ \t]*$/u
const REQUIRED_FIELD = /^ {0,3}\*\*(Status|Context|Decision|Consequences):\*\*[ \t]*(.*)$/u

/**
 * Parse the host-authoritative ADR subset of a markdown decision document.
 * Fenced examples are untrusted prose, not decisions or required fields.
 */
export function parseArchitectureDecisionDocument(
    document: string,
): ArchitectureDecisionDocument {
    if (typeof document !== "string" || document.trim().length === 0) {
        throw new ArchitectureDecisionDocumentError(
            "architecture decision document must be non-empty text",
        )
    }

    const lines = linesOutsideFencedCodeBlocks(document)
    const headings: DecisionHeading[] = []
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const match = ADR_HEADING.exec(lines[lineIndex]!.text)
        if (!match) continue
        headings.push({
            id: match[1]!,
            ordinal: Number.parseInt(match[2]!, 10),
            title: match[3]!.trim(),
            lineIndex,
        })
    }
    if (headings.length === 0) {
        throw new ArchitectureDecisionDocumentError(
            "architecture decision document contains no ADR headings outside fenced code blocks",
        )
    }

    const seenIds = new Set<string>()
    for (const heading of headings) {
        if (seenIds.has(heading.id)) {
            throw new ArchitectureDecisionDocumentError(
                `architecture decision document contains duplicate ADR id ${heading.id}`,
            )
        }
        seenIds.add(heading.id)
    }
    for (let index = 0; index < headings.length; index++) {
        const expected = `ADR-${String(index + 1).padStart(3, "0")}`
        if (headings[index]!.id !== expected) {
            throw new ArchitectureDecisionDocumentError(
                `architecture decision ids must be contiguous from ADR-001; expected ${expected} but found ${headings[index]!.id}`,
            )
        }
    }

    const decisions = headings.map((heading) => {
        const sectionEnd = findSectionEnd(lines, heading.lineIndex + 1)
        const fields = parseRequiredFields(
            lines.slice(heading.lineIndex + 1, sectionEnd),
            heading.id,
        )
        return Object.freeze({
            id: heading.id,
            ordinal: heading.ordinal,
            title: heading.title,
            status: "Accepted" as const,
            context: fields.Context,
            decision: fields.Decision,
            consequences: fields.Consequences,
        })
    })

    return Object.freeze({
        decisions: Object.freeze(decisions),
        hasExistingContext: lines.some(({ text }) =>
            EXISTING_CONTEXT_HEADING.test(text),
        ),
    })
}

function parseRequiredFields(
    lines: readonly VisibleLine[],
    decisionId: string,
): Record<RequiredField, string> {
    const values = new Map<RequiredField, string>()
    for (const { text } of lines) {
        const match = REQUIRED_FIELD.exec(text)
        if (!match) continue
        const field = match[1] as RequiredField
        if (values.has(field)) {
            throw new ArchitectureDecisionDocumentError(
                `${decisionId} contains duplicate **${field}:** fields`,
            )
        }
        values.set(field, match[2]!.trim())
    }

    const status = values.get("Status")
    if (status !== "Accepted") {
        throw new ArchitectureDecisionDocumentError(
            `${decisionId} must declare **Status:** Accepted`,
        )
    }
    for (const field of ["Context", "Decision", "Consequences"] as const) {
        if (!values.get(field)) {
            throw new ArchitectureDecisionDocumentError(
                `${decisionId} requires a non-empty **${field}:** field`,
            )
        }
    }

    return {
        Status: status,
        Context: values.get("Context")!,
        Decision: values.get("Decision")!,
        Consequences: values.get("Consequences")!,
    }
}

function findSectionEnd(lines: readonly VisibleLine[], start: number): number {
    for (let index = start; index < lines.length; index++) {
        if (LEVEL_TWO_HEADING.test(lines[index]!.text)) return index
    }
    return lines.length
}

function linesOutsideFencedCodeBlocks(document: string): VisibleLine[] {
    const normalized = document.replace(/\r\n?/gu, "\n")
    const result: VisibleLine[] = []
    let fence: { marker: "`" | "~"; length: number } | undefined

    normalized.split("\n").forEach((text, index) => {
        const marker = fenceMarker(text)
        if (fence) {
            if (
                marker?.character === fence.marker &&
                marker.length >= fence.length &&
                marker.remainder.trim().length === 0
            ) {
                fence = undefined
            }
            return
        }
        if (marker) {
            fence = { marker: marker.character, length: marker.length }
            return
        }
        result.push({ text, lineNumber: index + 1 })
    })

    return result
}

function fenceMarker(line: string): {
    character: "`" | "~"
    length: number
    remainder: string
} | undefined {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (!match) return undefined
    const marker = match[1]!
    return {
        character: marker[0] as "`" | "~",
        length: marker.length,
        remainder: match[2]!,
    }
}
