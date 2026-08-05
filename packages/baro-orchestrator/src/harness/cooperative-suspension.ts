/**
 * Cooperative suspension, once, for every harness lane.
 *
 * A story that discovers a prerequisite is missing asks the Board to suspend
 * it rather than faking the prerequisite or failing. Accepting that request
 * means the host is about to snapshot the story's worktree — so the agent owes
 * a certificate that nothing of its own can still write. The rules around that
 * certificate are the same everywhere: one block at a time, a validated id, no
 * new work after the request, a named refusal when the certificate cannot be
 * given, and a suspension that settles as a cooperated decision rather than a
 * failure to recover from.
 *
 * Exactly one thing differs per lane, and it is the witness:
 *
 *   CLI lanes   — the operating system says the process group is gone.
 *   Native lanes — the in-flight invocation set drained to empty, which is a
 *                  witness only because no invocation may begin after the
 *                  request (see `blocksNewWork`).
 *
 * So a lane supplies `quiesce` and nothing else. Adding a backend is writing
 * one function that answers "can you prove you are quiet".
 */

/**
 * Where a lane's proof of quiescence comes from.
 *
 * `self` — the lane owns its own work and can refuse to start more, so an
 *          empty in-flight set is proof it produced itself.
 * `process` — the lane spawns a process and borrows the operating system's
 *          proof that the process group is gone.
 *
 * Placing this next to the rule rather than in a shared caller keeps the
 * capability an adapter fact; a caller that switches on a backend name is a
 * caller that has to be edited for every new adapter.
 */
export type QuiescenceWitnessKind = "self" | "process"

export function laneQuiescenceWitness(
    backend: string,
): QuiescenceWitnessKind {
    return backend === "openai" ? "self" : "process"
}

export interface QuiescenceWitness {
    /**
     * Resolve true only when nothing this story owns can still write. A lane
     * that cannot decide within the bound must resolve false rather than
     * guess — the caller then retains the worktree instead of snapshotting a
     * live one.
     */
    (timeoutMs: number): Promise<boolean>
}

export interface CooperativeSuspensionSummary {
    attempts: number
    durationSecs: number
}

export class CooperativeSuspension {
    private blockId: string | null = null

    constructor(
        private readonly storyId: string,
        private readonly quiesce: QuiescenceWitness,
        private readonly timeoutMs: number,
    ) {}

    /** The accepted block this story is suspending for, if any. */
    get acceptedBlockId(): string | null {
        return this.blockId
    }

    /** True once no further work may begin, which is what makes a witness one. */
    get blocksNewWork(): boolean {
        return this.blockId !== null
    }

    /** How a settled suspension reads in the story's outcome. */
    get outcomeText(): string {
        return `suspended on dependency block ${this.blockId}`
    }

    /**
     * Record the request and wait for the lane's witness. Throws rather than
     * returning a summary the host would read as a certificate: a refusal
     * costs a retained worktree, a false certificate costs a silent write into
     * a branch already snapshotted.
     */
    async request(
        blockId: string,
        summary: () => CooperativeSuspensionSummary,
    ): Promise<CooperativeSuspensionSummary> {
        this.record(blockId)
        if (!(await this.quiesce(this.timeoutMs))) {
            throw new Error(
                `story ${this.storyId} quiescence could not be certified ` +
                    `for dependency block ${blockId}`,
            )
        }
        return summary()
    }

    private record(blockId: string): void {
        if (
            typeof blockId !== "string" ||
            blockId.trim() !== blockId ||
            !blockId
        ) {
            throw new TypeError(
                "suspension blockId must be a non-empty trimmed string",
            )
        }
        if (this.blockId !== null && this.blockId !== blockId) {
            throw new Error(
                `story ${this.storyId} is already suspending for block ${this.blockId}`,
            )
        }
        this.blockId ??= blockId
    }
}

/**
 * Drain a set of in-flight promises within a bound. The native lanes' witness,
 * kept here so a second one does not reinvent it.
 *
 * `Promise.allSettled` across one participant's own work is the legitimate use
 * of it; the trap is awaiting across actors, which is what the bus is for.
 */
export async function settledWithinBound(
    inFlight: () => readonly Promise<unknown>[],
    timeoutMs: number,
): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    // What has already been awaited, so a caller whose collection does not
    // shrink still terminates — and one that grows is still covered, which is
    // the case a suspension has already ruled out but should not depend on.
    const awaited = new Set<Promise<unknown>>()
    for (;;) {
        const pending = inFlight().filter((entry) => !awaited.has(entry))
        if (pending.length === 0) return true
        const remaining = deadline - Date.now()
        if (remaining <= 0) return false
        if (!(await raceBound(Promise.allSettled(pending), remaining))) {
            return false
        }
        for (const entry of pending) awaited.add(entry)
    }
}

/** True if `work` settled first; the timer is always cleared either way. */
async function raceBound(
    work: Promise<unknown>,
    timeoutMs: number,
): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
