# ADR-0005: Carry the suspension resume as a structured `resume` field on StorySpawnRequestData

**Status:** Accepted
**Context:** The factory cannot tell a resume from a first spawn: `StorySpawnRequestData` has no resume field and the preserved branch reaches it only as prompt prose (collective-board.ts:2950-2984). Parsing prose is unacceptable. `WorkOfferedData.request` is the same `StorySpawnRequestData` (events/market.ts:45), so a single optional field covers offer and spawn without a second schema.
**Decision:** In packages/baro-orchestrator/src/events/execution.ts add, next to `StorySpawnRequestData`:
```ts
/** Set only when this attempt resumes a story the host suspended; the
 *  preserved ref is null when no recovery material survived cleanup. */
export interface StoryResumeDirective {
    readonly preservedBranch: string | null
}
```
and add `resume?: StoryResumeDirective` as an OPTIONAL field of `StorySpawnRequestData` (additive, no wire `type` change).
In packages/baro-orchestrator/src/execution/collective-board.ts, in `offerStory` (~:2941-2984), when the remembered `recoveryContext.kind === "dependency"`, set `resume: { preservedBranch: recovery.branch ?? null }` on the `request` it puts in `WorkOffered`. Leave `buildRecoveryPromptSection` and the existing prompt prose exactly as-is. Do not set `resume` for `kind: "execution"` or any other recovery kind.
In packages/baro-orchestrator/src/market/story-factory.ts, propagate `resume` unchanged when it builds `StorySpawnRequest` from `WorkOffered` (~:449-458).
**Consequences:** Purely additive: existing producers/consumers that omit `resume` behave exactly as today, and the existing dependency-block prompt assertions (test/execution/collective-board-dependency-block.test.ts:180-192) keep passing. `preservedBranch: null` explicitly means 'resume, but nothing to replay' and must not be conflated with an absent `resume`.
