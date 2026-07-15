import { Buffer } from "node:buffer"

export const DEFAULT_REPOSITORY_RESEARCH_PROMPT_BYTES = 128 * 1024

export interface BoundedResearchPromptInput {
    /**
     * Trusted control fields which remain stable for the whole research run.
     * Keep these ahead of the large goal/bootstrap sections so provider prefix
     * caches can reuse the same bytes on every step.
     */
    readonly stableMetadata: readonly string[]
    readonly userGoal: string
    readonly bootstrapEvidence: string
    /** Step/attempt control fields which necessarily change between calls. */
    readonly dynamicMetadata: readonly string[]
    readonly observations: readonly unknown[]
    readonly repairLines: readonly string[]
    readonly finalInstruction: string
    readonly maximumTranscriptBytes: number
    /** Deterministic per-run cap for the complete stable prefix. */
    readonly maximumStablePrefixBytes: number
    readonly maximumBytes: number
}

export type BoundedResearchStablePrefixInput = Pick<
    BoundedResearchPromptInput,
    | "stableMetadata"
    | "userGoal"
    | "bootstrapEvidence"
    | "maximumStablePrefixBytes"
>

export interface BoundedResearchStablePrefixProjection {
    readonly text: string
    /** Exact bootstrap bytes present in the provider-visible stable prefix. */
    readonly bootstrapEvidence: string
    readonly bootstrapClipped: boolean
}

export interface BoundedResearchPromptProjection {
    readonly text: string
    readonly stablePrefix: BoundedResearchStablePrefixProjection
    /** First original observation that is present in the final prompt. */
    readonly visibleObservationStartIndex: number
    readonly omittedObservationCount: number
}

/**
 * Compose the final RepoScout user prompt under one real UTF-8 byte bound.
 * Stable correlation, goal, and bootstrap evidence form the prompt prefix.
 * Dynamic step control, repair guidance, and the newest complete tool
 * observation follow it. Mandatory control and the newest observation are
 * preserved; older observations and large data sections are reduced with
 * explicit markers.
 */
export function buildBoundedResearchPrompt(
    input: BoundedResearchPromptInput,
): string {
    return buildBoundedResearchPromptProjection(input).text
}

export function buildBoundedResearchPromptProjection(
    input: BoundedResearchPromptInput,
): BoundedResearchPromptProjection {
    assertPositiveBound(input.maximumBytes, "maximumBytes")
    assertPositiveBound(input.maximumTranscriptBytes, "maximumTranscriptBytes")
    assertPositiveBound(input.maximumStablePrefixBytes, "maximumStablePrefixBytes")
    if (input.maximumStablePrefixBytes >= input.maximumBytes) {
        throw new RangeError("maximumStablePrefixBytes must leave room for dynamic control")
    }
    const observations = input.observations.map((item) => JSON.stringify(item))
    if (observations.some((item) => item === undefined)) {
        throw new TypeError("research observations must be JSON serializable")
    }

    const stableProjection = projectBoundedResearchStablePrefix(input)
    const stablePrefix = stableProjection.text
    const fullTranscript = projectObservations(
        observations as string[],
        input.maximumTranscriptBytes,
        "transcript",
    )
    const full = stablePrefix + renderDynamicSuffix(input, fullTranscript.text)
    if (utf8Bytes(full) <= input.maximumBytes) {
        return promptProjection(full, stableProjection, fullTranscript)
    }

    const minimumTranscript = projectObservations(
        observations as string[],
        input.maximumTranscriptBytes,
        "total prompt",
        true,
    )
    const minimum = stablePrefix + renderDynamicSuffix(input, minimumTranscript.text)
    if (utf8Bytes(minimum) > input.maximumBytes) {
        throw new RangeError(
            "research prompt bound cannot preserve control text and newest observation",
        )
    }

    const withoutTranscript = stablePrefix + renderDynamicSuffix(input, "")
    const transcriptBudget = Math.min(
        input.maximumTranscriptBytes,
        input.maximumBytes - utf8Bytes(withoutTranscript) + utf8Bytes("(none)"),
    )
    const transcript = projectObservations(
        observations as string[],
        transcriptBudget,
        "total prompt",
    )
    const result = stablePrefix + renderDynamicSuffix(input, transcript.text)
    if (utf8Bytes(result) > input.maximumBytes) {
        throw new RangeError("research prompt exceeded its final UTF-8 bound")
    }
    return promptProjection(result, stableProjection, transcript)
}

function promptProjection(
    text: string,
    stablePrefix: BoundedResearchStablePrefixProjection,
    observations: ObservationProjection,
): BoundedResearchPromptProjection {
    return Object.freeze({
        text,
        stablePrefix,
        visibleObservationStartIndex: observations.visibleStartIndex,
        omittedObservationCount: observations.omittedCount,
    })
}

/**
 * Project stable data independently of step-local transcript/control bytes.
 * The same run inputs and stable cap therefore always produce the same exact
 * provider-cache prefix, even after the total-prompt clipping path is entered.
 */
export function projectBoundedResearchStablePrefix(
    input: BoundedResearchStablePrefixInput,
): BoundedResearchStablePrefixProjection {
    assertPositiveBound(input.maximumStablePrefixBytes, "maximumStablePrefixBytes")
    const full = renderStablePrefix(input, input.userGoal, input.bootstrapEvidence)
    if (utf8Bytes(full) <= input.maximumStablePrefixBytes) {
        return Object.freeze({
            text: full,
            bootstrapEvidence: input.bootstrapEvidence,
            bootstrapClipped: false,
        })
    }

    const fixed = renderStablePrefix(input, "", "")
    let remaining = input.maximumStablePrefixBytes - utf8Bytes(fixed)
    if (remaining < 0) {
        throw new RangeError(
            "stable research prefix bound cannot preserve trusted control text",
        )
    }
    const goalBytes = utf8Bytes(input.userGoal)
    const bootstrapBytes = utf8Bytes(input.bootstrapEvidence)
    let goal = input.userGoal
    let bootstrap = input.bootstrapEvidence
    if (goalBytes + bootstrapBytes > remaining) {
        const bootstrapMinimum = bootstrapBytes === 0
            ? 0
            : utf8Bytes(clipMarker("bootstrap evidence"))
        const goalBudget = Math.min(
            goalBytes,
            Math.max(utf8Bytes(clipMarker("user goal")), remaining - bootstrapMinimum),
        )
        goal = clipSection(input.userGoal, goalBudget, "user goal")
        remaining -= utf8Bytes(goal)
        bootstrap = clipSection(
            input.bootstrapEvidence,
            remaining,
            "bootstrap evidence",
        )
    }

    const result = renderStablePrefix(input, goal, bootstrap)
    if (utf8Bytes(result) > input.maximumStablePrefixBytes) {
        throw new RangeError("stable research prefix exceeded its final UTF-8 bound")
    }
    return Object.freeze({
        text: result,
        bootstrapEvidence: bootstrap,
        bootstrapClipped: bootstrap !== input.bootstrapEvidence,
    })
}

function renderStablePrefix(
    input: BoundedResearchStablePrefixInput,
    goal: string,
    bootstrap: string,
): string {
    return [
        ...input.stableMetadata,
        "",
        "USER GOAL:",
        goal,
        "",
        "BOOTSTRAP EVIDENCE (UNTRUSTED REPOSITORY DATA):",
        bootstrap,
        "",
        "",
    ].join("\n")
}

function renderDynamicSuffix(
    input: BoundedResearchPromptInput,
    transcript: string,
): string {
    return [
        "TRUSTED CURRENT RESEARCH CONTROL:",
        ...input.dynamicMetadata,
        "",
        "PRIOR TOOL OBSERVATIONS (UNTRUSTED REPOSITORY DATA):",
        transcript || "(none)",
        ...input.repairLines,
        "",
        input.finalInstruction,
    ].join("\n")
}

interface ObservationProjection {
    readonly text: string
    readonly visibleStartIndex: number
    readonly omittedCount: number
}

function projectObservations(
    observations: readonly string[],
    maximumBytes: number,
    markerReason: string,
    latestOnly = false,
): ObservationProjection {
    if (observations.length === 0) {
        return { text: "(none)", visibleStartIndex: 0, omittedCount: 0 }
    }
    const full = observations.join("\n")
    if (!latestOnly && utf8Bytes(full) <= maximumBytes) {
        return { text: full, visibleStartIndex: 0, omittedCount: 0 }
    }

    const selected: string[] = []
    for (let index = observations.length - 1; index >= 0; index -= 1) {
        const candidate = [observations[index]!, ...selected]
        const omitted = index
        const projected = [
            ...(omitted > 0 ? [observationMarker(omitted, markerReason)] : []),
            ...candidate,
        ].join("\n")
        if (utf8Bytes(projected) > maximumBytes) break
        selected.unshift(observations[index]!)
        if (latestOnly) break
    }
    const omitted = observations.length - selected.length
    const projected = [
        ...(omitted > 0 ? [observationMarker(omitted, markerReason)] : []),
        ...selected,
    ].join("\n")
    if (selected.length === 0 || utf8Bytes(projected) > maximumBytes) {
        throw new RangeError(
            "research transcript bound cannot preserve the newest observation",
        )
    }
    return {
        text: projected,
        visibleStartIndex: omitted,
        omittedCount: omitted,
    }
}

function clipSection(value: string, maximumBytes: number, label: string): string {
    if (utf8Bytes(value) <= maximumBytes) return value
    const marker = clipMarker(label)
    const markerBytes = utf8Bytes(marker)
    if (maximumBytes < markerBytes) {
        throw new RangeError(`research prompt cannot preserve ${label} clipping marker`)
    }
    const prefixBudget = maximumBytes - markerBytes
    let low = 0
    let high = value.length
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (utf8Bytes(value.slice(0, middle)) <= prefixBudget) low = middle
        else high = middle - 1
    }
    const prefix = value.slice(0, low).replace(/[\uD800-\uDBFF]$/u, "")
    return `${prefix}${marker}`
}

function observationMarker(count: number, reason: string): string {
    return `[${count} older observation(s) omitted by ${reason} bound]`
}

function clipMarker(label: string): string {
    return `\n[${label} clipped by total prompt bound]`
}

function utf8Bytes(value: string): number {
    return Buffer.byteLength(value, "utf8")
}

function assertPositiveBound(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${label} must be a positive safe integer`)
    }
}
