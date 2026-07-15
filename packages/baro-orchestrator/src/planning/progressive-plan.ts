import { createHash } from "node:crypto"

import {
    MAX_STORY_PRIORITY,
    MAX_STORY_RETRIES,
    MIN_STORY_PRIORITY,
    type PrdFile,
    type PrdStory,
} from "../prd.js"

export const PROGRESSIVE_PLAN_SCHEMA_VERSION = 1 as const

const MAX_ID_CHARS = 256
const MAX_TEXT_CHARS = 64 * 1024
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u

export interface ProgressivePlanOpenV1 {
    schemaVersion: typeof PROGRESSIVE_PLAN_SCHEMA_VERSION
    planningSessionId: string
}

/**
 * One immutable, add-only planner contribution. Ordinals begin at one and are
 * continuous for newly admitted fragment IDs. Dependencies may name a story
 * admitted by an earlier fragment or another story in this same fragment.
 */
export interface ProgressivePlanFragmentV1 {
    schemaVersion: typeof PROGRESSIVE_PLAN_SCHEMA_VERSION
    planningSessionId: string
    fragmentId: string
    ordinal: number
    stories: PrdStory[]
}

export type ProgressivePlanPhase = "open" | "reconciled"

export type ProgressivePlanContractErrorCode =
    | "invalid_open"
    | "invalid_fragment"
    | "session_mismatch"
    | "session_closed"
    | "fragment_conflict"
    | "non_contiguous_ordinal"
    | "duplicate_story"
    | "forward_reference"
    | "dependency_cycle"
    | "invalid_final_prd"
    | "invalid_snapshot"
    | "empty_plan"
    | "final_prd_mismatch"
    | "final_prd_conflict"

export class ProgressivePlanContractError extends Error {
    constructor(
        readonly code: ProgressivePlanContractErrorCode,
        message: string,
    ) {
        super(message)
        this.name = "ProgressivePlanContractError"
    }
}

export interface ProgressivePlanAdmissionV1 {
    schemaVersion: typeof PROGRESSIVE_PLAN_SCHEMA_VERSION
    planningSessionId: string
    fragmentId: string
    ordinal: number
    fingerprint: string
    disposition: "admitted" | "replayed"
    admittedStoryIds: string[]
    nextOrdinal: number
}

export interface ProgressivePlanFragmentRecordV1 {
    fragmentId: string
    ordinal: number
    fingerprint: string
    storyIds: string[]
}

export interface ProgressivePlanSnapshotV1 {
    schemaVersion: typeof PROGRESSIVE_PLAN_SCHEMA_VERSION
    planningSessionId: string
    phase: ProgressivePlanPhase
    nextOrdinal: number
    fragments: ProgressivePlanFragmentRecordV1[]
    stories: PrdStory[]
    finalStoriesFingerprint: string | null
    /** Final-only stories that were never eligible for early admission. */
    finalTail: PrdStory[] | null
}

export interface ProgressivePlanStoryReconciliationV1 {
    finalStories: PrdStory[]
    /** Nonempty or empty suffix that the final Planner response added. */
    tail: PrdStory[]
}

export interface ProgressivePlanReconciliationV1 {
    schemaVersion: typeof PROGRESSIVE_PLAN_SCHEMA_VERSION
    planningSessionId: string
    disposition: "reconciled" | "replayed"
    fragmentCount: number
    admittedStoryCount: number
    finalStoryCount: number
    tail: PrdStory[]
    finalStoriesFingerprint: string
}

interface RememberedFragment {
    fragment: ProgressivePlanFragmentV1
    fingerprint: string
}

/** Validate and snapshot an exact v1 open-session envelope. */
export function validateProgressivePlanOpen(
    value: unknown,
): ProgressivePlanOpenV1 {
    if (!isExactRecord(value, ["schemaVersion", "planningSessionId"])) {
        throw contractError("invalid_open", "progressive plan open envelope is not exact v1")
    }
    if (value.schemaVersion !== PROGRESSIVE_PLAN_SCHEMA_VERSION) {
        throw contractError("invalid_open", "unsupported progressive plan schemaVersion")
    }
    return {
        schemaVersion: PROGRESSIVE_PLAN_SCHEMA_VERSION,
        planningSessionId: safeId(
            value.planningSessionId,
            "planningSessionId",
            "invalid_open",
        ),
    }
}

/**
 * Validate the transport shape and story payload, without consulting session
 * state. Closure, continuity, and add-only identity are session-level checks.
 */
export function validateProgressivePlanFragment(
    value: unknown,
): ProgressivePlanFragmentV1 {
    if (
        !isExactRecord(value, [
            "schemaVersion",
            "planningSessionId",
            "fragmentId",
            "ordinal",
            "stories",
        ])
    ) {
        throw contractError(
            "invalid_fragment",
            "progressive plan fragment is not exact v1",
        )
    }
    if (value.schemaVersion !== PROGRESSIVE_PLAN_SCHEMA_VERSION) {
        throw contractError("invalid_fragment", "unsupported progressive plan schemaVersion")
    }
    const planningSessionId = safeId(
        value.planningSessionId,
        "planningSessionId",
        "invalid_fragment",
    )
    const fragmentId = safeId(value.fragmentId, "fragmentId", "invalid_fragment")
    if (!Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 1) {
        throw contractError(
            "invalid_fragment",
            "progressive plan fragment ordinal must be a positive safe integer",
        )
    }
    if (!Array.isArray(value.stories) || value.stories.length === 0) {
        throw contractError(
            "invalid_fragment",
            "progressive plan fragment must add at least one story",
        )
    }
    const stories = value.stories.map((story, index) =>
        validateProgressivePlannerStory(story, `fragment story ${index + 1}`),
    )
    return {
        schemaVersion: PROGRESSIVE_PLAN_SCHEMA_VERSION,
        planningSessionId,
        fragmentId,
        ordinal: Number(value.ordinal),
        stories,
    }
}

/** Validate and deep-copy the exact execution-neutral PrdStory shape. */
export function validateProgressivePlannerStory(
    value: unknown,
    label = "planner story",
): PrdStory {
    if (
        !isRecordWithOptionalKey(
            value,
            [
                "id",
                "priority",
                "title",
                "description",
                "dependsOn",
                "retries",
                "acceptance",
                "tests",
                "passes",
                "completedAt",
                "durationSecs",
            ],
            "model",
        )
    ) {
        throw contractError(
            "invalid_fragment",
            `${label} has missing or unknown fields`,
        )
    }

    const id = safeId(value.id, `${label} id`, "invalid_fragment")
    if (
        !Number.isInteger(value.priority) ||
        Number(value.priority) < MIN_STORY_PRIORITY ||
        Number(value.priority) > MAX_STORY_PRIORITY
    ) {
        throw contractError("invalid_fragment", `${label} '${id}' has invalid i32 priority`)
    }
    const title = safeText(value.title, `${label} '${id}' title`, "invalid_fragment")
    const description = safeText(
        value.description,
        `${label} '${id}' description`,
        "invalid_fragment",
    )
    const dependsOn = safeIdArray(
        value.dependsOn,
        `${label} '${id}' dependencies`,
        true,
        "invalid_fragment",
    )
    if (dependsOn.includes(id)) {
        throw contractError(
            "invalid_fragment",
            `${label} '${id}' cannot depend on itself`,
        )
    }
    if (
        !Number.isInteger(value.retries) ||
        Number(value.retries) < 0 ||
        Number(value.retries) > MAX_STORY_RETRIES
    ) {
        throw contractError(
            "invalid_fragment",
            `${label} '${id}' retries must be between 0 and ${MAX_STORY_RETRIES}`,
        )
    }
    const acceptance = safeTextArray(
        value.acceptance,
        `${label} '${id}' acceptance`,
        false,
        "invalid_fragment",
    )
    const tests = safeTextArray(
        value.tests,
        `${label} '${id}' tests`,
        false,
        "invalid_fragment",
    )
    if (
        value.passes !== false ||
        value.completedAt !== null ||
        value.durationSecs !== null
    ) {
        throw contractError(
            "invalid_fragment",
            `${label} '${id}' must be execution-neutral`,
        )
    }
    if (value.model !== undefined && !isSafeText(value.model)) {
        throw contractError("invalid_fragment", `${label} '${id}' has invalid model`)
    }

    return {
        id,
        priority: Number(value.priority),
        title,
        description,
        dependsOn,
        retries: Number(value.retries),
        acceptance,
        tests,
        passes: false,
        completedAt: null,
        durationSecs: null,
        ...(value.model !== undefined ? { model: value.model } : {}),
    }
}

/** Stable SHA-256 over a recursively key-sorted, array-order-preserving payload. */
export function progressivePlanFragmentFingerprint(value: unknown): string {
    return canonicalFingerprint(validateProgressivePlanFragment(value))
}

/**
 * Require every admitted story to be an exact, same-order prefix of the final
 * PRD. The final response may append a nonempty suffix that was intentionally
 * withheld from early execution. Metadata is outside this boundary and remains
 * owned by the final PRD validator.
 */
export function reconcileProgressivePlanStories(
    admittedStories: readonly PrdStory[],
    finalPrd: unknown,
): ProgressivePlanStoryReconciliationV1 {
    if (!isPlainRecord(finalPrd) || !Array.isArray(finalPrd.userStories)) {
        throw contractError(
            "invalid_final_prd",
            "final PRD must be an object with a userStories array",
        )
    }
    const admitted = admittedStories.map((story, index) =>
        validateFinalStory(story, `admitted story ${index + 1}`),
    )
    const finalStories = finalPrd.userStories.map((story, index) =>
        validateFinalStory(story, `final PRD story ${index + 1}`),
    )
    assertCompleteFinalGraph(finalStories)
    if (finalStories.length === 0) {
        throw contractError("empty_plan", "final progressive plan must contain a story")
    }
    if (finalStories.length < admitted.length) {
        throw contractError(
            "final_prd_mismatch",
            `final PRD has ${finalStories.length} stories; admitted prefix has ${admitted.length}`,
        )
    }
    for (let index = 0; index < admitted.length; index += 1) {
        const expected = admitted[index]!
        const actual = finalStories[index]!
        if (canonicalJson(expected) !== canonicalJson(actual)) {
            throw contractError(
                "final_prd_mismatch",
                `final PRD story ${index + 1} does not exactly match admitted prefix story '${expected.id}'`,
            )
        }
    }
    return {
        finalStories,
        tail: finalStories.slice(admitted.length).map(snapshotStory),
    }
}

/** Open one isolated progressive-planning transaction. */
export function openProgressivePlanSession(
    value: unknown,
): ProgressivePlanSession {
    return new ProgressivePlanSession(value)
}

/**
 * Rebuild a session exclusively through its public admission/reconciliation
 * transitions. Malformed durable state never receives a direct path into the
 * private idempotency maps.
 */
export function restoreProgressivePlanSession(
    value: unknown,
): ProgressivePlanSession {
    try {
        return restoreSnapshot(value)
    } catch (error) {
        if (
            error instanceof ProgressivePlanContractError &&
            error.code === "invalid_snapshot"
        ) {
            throw error
        }
        const reason = error instanceof Error ? error.message : String(error)
        throw contractError("invalid_snapshot", `invalid progressive plan snapshot: ${reason}`)
    }
}

export class ProgressivePlanSession {
    readonly planningSessionId: string
    private phaseValue: ProgressivePlanPhase = "open"
    private nextOrdinalValue = 1
    private readonly fragments: RememberedFragment[] = []
    private readonly fragmentsById = new Map<string, RememberedFragment>()
    private readonly admittedStories: PrdStory[] = []
    private readonly admittedStoryIds = new Set<string>()
    private finalStoriesFingerprintValue: string | null = null
    private finalTailValue: PrdStory[] | null = null

    constructor(value: unknown) {
        this.planningSessionId = validateProgressivePlanOpen(value).planningSessionId
    }

    get phase(): ProgressivePlanPhase {
        return this.phaseValue
    }

    get nextOrdinal(): number {
        return this.nextOrdinalValue
    }

    admit(value: unknown): ProgressivePlanAdmissionV1 {
        const fragment = validateProgressivePlanFragment(value)
        if (fragment.planningSessionId !== this.planningSessionId) {
            throw contractError(
                "session_mismatch",
                `fragment session '${fragment.planningSessionId}' does not match '${this.planningSessionId}'`,
            )
        }
        const fingerprint = canonicalFingerprint(fragment)
        const remembered = this.fragmentsById.get(fragment.fragmentId)
        if (remembered) {
            if (remembered.fingerprint !== fingerprint) {
                throw contractError(
                    "fragment_conflict",
                    `fragmentId '${fragment.fragmentId}' was reused with different content`,
                )
            }
            return this.admissionResult(remembered, "replayed")
        }
        if (this.phaseValue !== "open") {
            throw contractError(
                "session_closed",
                `progressive planning session '${this.planningSessionId}' is reconciled`,
            )
        }
        if (fragment.ordinal !== this.nextOrdinalValue) {
            throw contractError(
                "non_contiguous_ordinal",
                `fragment '${fragment.fragmentId}' has ordinal ${fragment.ordinal}; expected ${this.nextOrdinalValue}`,
            )
        }

        const fragmentIds = new Set<string>()
        for (const story of fragment.stories) {
            if (fragmentIds.has(story.id) || this.admittedStoryIds.has(story.id)) {
                throw contractError(
                    "duplicate_story",
                    `story '${story.id}' was already admitted or repeated in the fragment`,
                )
            }
            fragmentIds.add(story.id)
        }
        for (const story of fragment.stories) {
            const unknown = story.dependsOn.find(
                (dependency) =>
                    !this.admittedStoryIds.has(dependency) &&
                    !fragmentIds.has(dependency),
            )
            if (unknown !== undefined) {
                throw contractError(
                    "forward_reference",
                    `story '${story.id}' depends on unknown provisional story '${unknown}'`,
                )
            }
        }
        assertFragmentAcyclic(fragment.stories, fragmentIds)

        const rememberedFragment: RememberedFragment = {
            fragment: snapshotFragment(fragment),
            fingerprint,
        }
        // Commit only after every fragment-level check succeeds.
        this.fragments.push(rememberedFragment)
        this.fragmentsById.set(fragment.fragmentId, rememberedFragment)
        for (const story of rememberedFragment.fragment.stories) {
            this.admittedStories.push(snapshotStory(story))
            this.admittedStoryIds.add(story.id)
        }
        this.nextOrdinalValue += 1
        return this.admissionResult(rememberedFragment, "admitted")
    }

    reconcile(finalPrd: PrdFile | unknown): ProgressivePlanReconciliationV1 {
        if (!isPlainRecord(finalPrd) || !Array.isArray(finalPrd.userStories)) {
            throw contractError(
                "invalid_final_prd",
                "final PRD must be an object with a userStories array",
            )
        }
        const candidateFingerprint = canonicalFingerprint(
            finalPrd.userStories.map((story, index) =>
                validateFinalStory(story, `final PRD story ${index + 1}`),
            ),
        )
        if (this.phaseValue === "reconciled") {
            if (candidateFingerprint !== this.finalStoriesFingerprintValue) {
                throw contractError(
                    "final_prd_conflict",
                    "progressive planning session was already reconciled with a different final PRD",
                )
            }
            return this.reconciliationResult("replayed", candidateFingerprint)
        }

        const reconciliation = reconcileProgressivePlanStories(
            this.admittedStories,
            finalPrd,
        )
        const finalStoriesFingerprint = canonicalFingerprint(reconciliation.finalStories)
        this.phaseValue = "reconciled"
        this.finalStoriesFingerprintValue = finalStoriesFingerprint
        this.finalTailValue = reconciliation.tail.map(snapshotStory)
        return this.reconciliationResult(
            "reconciled",
            finalStoriesFingerprint,
            reconciliation.finalStories.length,
        )
    }

    snapshot(): ProgressivePlanSnapshotV1 {
        return {
            schemaVersion: PROGRESSIVE_PLAN_SCHEMA_VERSION,
            planningSessionId: this.planningSessionId,
            phase: this.phaseValue,
            nextOrdinal: this.nextOrdinalValue,
            fragments: this.fragments.map(({ fragment, fingerprint }) => ({
                fragmentId: fragment.fragmentId,
                ordinal: fragment.ordinal,
                fingerprint,
                storyIds: fragment.stories.map((story) => story.id),
            })),
            stories: this.admittedStories.map(snapshotStory),
            finalStoriesFingerprint: this.finalStoriesFingerprintValue,
            finalTail: this.finalTailValue?.map(snapshotStory) ?? null,
        }
    }

    private admissionResult(
        remembered: RememberedFragment,
        disposition: ProgressivePlanAdmissionV1["disposition"],
    ): ProgressivePlanAdmissionV1 {
        return {
            schemaVersion: PROGRESSIVE_PLAN_SCHEMA_VERSION,
            planningSessionId: this.planningSessionId,
            fragmentId: remembered.fragment.fragmentId,
            ordinal: remembered.fragment.ordinal,
            fingerprint: remembered.fingerprint,
            disposition,
            admittedStoryIds: remembered.fragment.stories.map((story) => story.id),
            nextOrdinal: this.nextOrdinalValue,
        }
    }

    private reconciliationResult(
        disposition: ProgressivePlanReconciliationV1["disposition"],
        finalStoriesFingerprint: string,
        finalStoryCount = this.admittedStories.length + (this.finalTailValue?.length ?? 0),
    ): ProgressivePlanReconciliationV1 {
        return {
            schemaVersion: PROGRESSIVE_PLAN_SCHEMA_VERSION,
            planningSessionId: this.planningSessionId,
            disposition,
            fragmentCount: this.fragments.length,
            admittedStoryCount: this.admittedStories.length,
            finalStoryCount,
            tail: this.finalTailValue?.map(snapshotStory) ?? [],
            finalStoriesFingerprint,
        }
    }
}

function restoreSnapshot(value: unknown): ProgressivePlanSession {
    if (
        !isExactRecord(value, [
            "schemaVersion",
            "planningSessionId",
            "phase",
            "nextOrdinal",
            "fragments",
            "stories",
            "finalStoriesFingerprint",
            "finalTail",
        ])
    ) {
        throw contractError("invalid_snapshot", "snapshot is not exact progressive-plan v1")
    }
    if (value.schemaVersion !== PROGRESSIVE_PLAN_SCHEMA_VERSION) {
        throw contractError("invalid_snapshot", "snapshot has unsupported schemaVersion")
    }
    const planningSessionId = safeId(
        value.planningSessionId,
        "snapshot planningSessionId",
        "invalid_snapshot",
    )
    if (value.phase !== "open" && value.phase !== "reconciled") {
        throw contractError("invalid_snapshot", "snapshot has invalid phase")
    }
    if (!Number.isSafeInteger(value.nextOrdinal) || Number(value.nextOrdinal) < 1) {
        throw contractError("invalid_snapshot", "snapshot nextOrdinal is invalid")
    }
    if (!Array.isArray(value.fragments) || !Array.isArray(value.stories)) {
        throw contractError("invalid_snapshot", "snapshot fragments and stories must be arrays")
    }

    const stories = value.stories.map((story, index) => {
        try {
            return validateProgressivePlannerStory(story, `snapshot story ${index + 1}`)
        } catch (error) {
            throw snapshotCause(error)
        }
    })
    const session = openProgressivePlanSession({
        schemaVersion: PROGRESSIVE_PLAN_SCHEMA_VERSION,
        planningSessionId,
    })
    let storyCursor = 0
    for (const [index, candidate] of value.fragments.entries()) {
        const record = validateSnapshotFragmentRecord(candidate, index)
        const fragmentStories = stories.slice(
            storyCursor,
            storyCursor + record.storyIds.length,
        )
        if (
            fragmentStories.length !== record.storyIds.length ||
            fragmentStories.some((story, storyIndex) => story.id !== record.storyIds[storyIndex])
        ) {
            throw contractError(
                "invalid_snapshot",
                `snapshot fragment '${record.fragmentId}' does not map exactly to the stored story sequence`,
            )
        }
        const fragment: ProgressivePlanFragmentV1 = {
            schemaVersion: PROGRESSIVE_PLAN_SCHEMA_VERSION,
            planningSessionId,
            fragmentId: record.fragmentId,
            ordinal: record.ordinal,
            stories: fragmentStories,
        }
        const fingerprint = canonicalFingerprint(fragment)
        if (fingerprint !== record.fingerprint) {
            throw contractError(
                "invalid_snapshot",
                `snapshot fragment '${record.fragmentId}' fingerprint does not match its content`,
            )
        }
        let admission: ProgressivePlanAdmissionV1
        try {
            admission = session.admit(fragment)
        } catch (error) {
            throw snapshotCause(error)
        }
        if (admission.disposition !== "admitted") {
            throw contractError(
                "invalid_snapshot",
                `snapshot fragment '${record.fragmentId}' is a duplicate replay`,
            )
        }
        storyCursor += record.storyIds.length
    }
    if (storyCursor !== stories.length) {
        throw contractError(
            "invalid_snapshot",
            "snapshot contains stories that are not owned by any fragment",
        )
    }
    if (session.nextOrdinal !== value.nextOrdinal) {
        throw contractError(
            "invalid_snapshot",
            `snapshot nextOrdinal ${String(value.nextOrdinal)} does not match replayed ordinal ${session.nextOrdinal}`,
        )
    }

    if (value.phase === "open") {
        if (value.finalStoriesFingerprint !== null || value.finalTail !== null) {
            throw contractError(
                "invalid_snapshot",
                "open snapshot cannot contain final reconciliation state",
            )
        }
        return session
    }
    if (!validFingerprint(value.finalStoriesFingerprint) || !Array.isArray(value.finalTail)) {
        throw contractError(
            "invalid_snapshot",
            "reconciled snapshot requires a canonical final fingerprint and tail",
        )
    }
    const finalTail = value.finalTail.map((story, index) => {
        try {
            return validateProgressivePlannerStory(story, `snapshot final tail ${index + 1}`)
        } catch (error) {
            throw snapshotCause(error)
        }
    })
    let reconciliation: ProgressivePlanReconciliationV1
    try {
        reconciliation = session.reconcile({
            userStories: [...stories.map(snapshotStory), ...finalTail],
        })
    } catch (error) {
        throw snapshotCause(error)
    }
    if (reconciliation.finalStoriesFingerprint !== value.finalStoriesFingerprint) {
        throw contractError(
            "invalid_snapshot",
            "snapshot final fingerprint does not match replayed final stories",
        )
    }
    return session
}

function validateSnapshotFragmentRecord(
    value: unknown,
    index: number,
): ProgressivePlanFragmentRecordV1 {
    if (!isExactRecord(value, ["fragmentId", "ordinal", "fingerprint", "storyIds"])) {
        throw contractError(
            "invalid_snapshot",
            `snapshot fragment record ${index + 1} is not exact`,
        )
    }
    const fragmentId = safeId(
        value.fragmentId,
        `snapshot fragment ${index + 1} id`,
        "invalid_snapshot",
    )
    if (!Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 1) {
        throw contractError(
            "invalid_snapshot",
            `snapshot fragment '${fragmentId}' has invalid ordinal`,
        )
    }
    if (!validFingerprint(value.fingerprint)) {
        throw contractError(
            "invalid_snapshot",
            `snapshot fragment '${fragmentId}' has invalid fingerprint`,
        )
    }
    const storyIds = safeIdArray(
        value.storyIds,
        `snapshot fragment '${fragmentId}' storyIds`,
        false,
        "invalid_snapshot",
    )
    return {
        fragmentId,
        ordinal: Number(value.ordinal),
        fingerprint: value.fingerprint,
        storyIds,
    }
}

function snapshotCause(error: unknown): ProgressivePlanContractError {
    const reason = error instanceof Error ? error.message : String(error)
    return contractError("invalid_snapshot", `snapshot replay failed: ${reason}`)
}

function validateFinalStory(value: unknown, label: string): PrdStory {
    try {
        return validateProgressivePlannerStory(value, label)
    } catch (error) {
        if (error instanceof ProgressivePlanContractError) {
            throw contractError("invalid_final_prd", error.message)
        }
        throw error
    }
}

function assertCompleteFinalGraph(stories: readonly PrdStory[]): void {
    const byId = new Map<string, PrdStory>()
    for (const story of stories) {
        if (byId.has(story.id)) {
            throw contractError(
                "invalid_final_prd",
                `final PRD contains duplicate story '${story.id}'`,
            )
        }
        byId.set(story.id, story)
    }
    for (const story of stories) {
        const unknown = story.dependsOn.find((dependency) => !byId.has(dependency))
        if (unknown !== undefined) {
            throw contractError(
                "invalid_final_prd",
                `final PRD story '${story.id}' depends on unknown story '${unknown}'`,
            )
        }
    }
    const completed = new Set<string>()
    while (completed.size < stories.length) {
        const ready = stories.filter(
            (story) =>
                !completed.has(story.id) &&
                story.dependsOn.every((dependency) => completed.has(dependency)),
        )
        if (ready.length === 0) {
            throw contractError("invalid_final_prd", "final PRD contains a dependency cycle")
        }
        for (const story of ready) completed.add(story.id)
    }
}

function assertFragmentAcyclic(
    stories: readonly PrdStory[],
    fragmentIds: ReadonlySet<string>,
): void {
    const remaining = new Map(stories.map((story) => [story.id, story]))
    const completed = new Set<string>()
    while (remaining.size > 0) {
        const ready = [...remaining.values()].filter((story) =>
            story.dependsOn.every(
                (dependency) =>
                    !fragmentIds.has(dependency) || completed.has(dependency),
            ),
        )
        if (ready.length === 0) {
            throw contractError(
                "dependency_cycle",
                "progressive plan fragment contains a dependency cycle",
            )
        }
        for (const story of ready) {
            remaining.delete(story.id)
            completed.add(story.id)
        }
    }
}

function snapshotFragment(fragment: ProgressivePlanFragmentV1): ProgressivePlanFragmentV1 {
    return {
        schemaVersion: PROGRESSIVE_PLAN_SCHEMA_VERSION,
        planningSessionId: fragment.planningSessionId,
        fragmentId: fragment.fragmentId,
        ordinal: fragment.ordinal,
        stories: fragment.stories.map(snapshotStory),
    }
}

function snapshotStory(story: PrdStory): PrdStory {
    return {
        id: story.id,
        priority: story.priority,
        title: story.title,
        description: story.description,
        dependsOn: [...story.dependsOn],
        retries: story.retries,
        acceptance: [...story.acceptance],
        tests: [...story.tests],
        passes: story.passes,
        completedAt: story.completedAt,
        durationSecs: story.durationSecs,
        ...(story.model !== undefined ? { model: story.model } : {}),
    }
}

function validFingerprint(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
}

function safeId(
    value: unknown,
    label: string,
    code: ProgressivePlanContractErrorCode,
): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_ID_CHARS ||
        value !== value.trim() ||
        FORBIDDEN_TEXT.test(value)
    ) {
        throw contractError(code, `${label} must be a safe, trimmed, non-empty string`)
    }
    return value
}

function safeText(
    value: unknown,
    label: string,
    code: ProgressivePlanContractErrorCode,
): string {
    if (!isSafeText(value)) {
        throw contractError(code, `${label} must be safe, bounded, non-blank text`)
    }
    return value
}

function isSafeText(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length <= MAX_TEXT_CHARS &&
        value.trim().length > 0 &&
        !FORBIDDEN_TEXT.test(value)
    )
}

function safeIdArray(
    value: unknown,
    label: string,
    allowEmpty: boolean,
    code: ProgressivePlanContractErrorCode,
): string[] {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
        throw contractError(code, `${label} must be ${allowEmpty ? "an" : "a non-empty"} array`)
    }
    const result = value.map((item, index) =>
        safeId(item, `${label} entry ${index + 1}`, code),
    )
    if (new Set(result).size !== result.length) {
        throw contractError(code, `${label} must not contain duplicates`)
    }
    return result
}

function safeTextArray(
    value: unknown,
    label: string,
    allowEmpty: boolean,
    code: ProgressivePlanContractErrorCode,
): string[] {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
        throw contractError(code, `${label} must be ${allowEmpty ? "an" : "a non-empty"} array`)
    }
    const result = value.map((item, index) =>
        safeText(item, `${label} entry ${index + 1}`, code),
    )
    if (new Set(result).size !== result.length) {
        throw contractError(code, `${label} must not contain duplicates`)
    }
    return result
}

function isExactRecord(
    value: unknown,
    keys: readonly string[],
): value is Record<string, unknown> {
    if (!isPlainRecord(value)) return false
    const actual = Object.keys(value)
    return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isRecordWithOptionalKey(
    value: unknown,
    required: readonly string[],
    optional: string,
): value is Record<string, unknown> {
    if (!isPlainRecord(value)) return false
    const keys = Object.keys(value)
    const allowed = new Set([...required, optional])
    return (
        required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
        keys.every((key) => allowed.has(key))
    )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function canonicalFingerprint(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue)
    if (!isPlainRecord(value)) return value
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonicalValue(value[key])]),
    )
}

function contractError(
    code: ProgressivePlanContractErrorCode,
    message: string,
): ProgressivePlanContractError {
    return new ProgressivePlanContractError(code, message)
}
