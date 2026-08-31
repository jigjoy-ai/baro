# ADR-0001: Keep the overlap rejection reason byte-identical and carry structured overlap facts beside it

**Status:** Accepted
**Context:** The retry message must name colliding owners and their owned files, but the reason string is pinned by exact equality (test/runtime-graph/runtime-replan-board.test.ts:932-937) and the goal forbids changing detection. The board exposes no story->files accessor, so the composer cannot recompute ownership; the alternative (widening the reason string) breaks the frozen assertion and would put message wording in runtime-replan.ts instead of planner-prompts.ts.
**Decision:** Declare in packages/baro-orchestrator/src/events/runtime-graph.ts, adjacent to the rejection-code union at line 108:

export interface WriteSurfaceOverlapOwner { storyId: string; ownedFiles: string[]; collidingPaths: string[] }
export interface WriteSurfaceOverlapFacts { candidateStoryId: string; owners: WriteSurfaceOverlapOwner[]; remainingPaths: string[] }

Add optional `overlap?: WriteSurfaceOverlapFacts` to the `RuntimeReplanRejected` event data in that same file.

In src/runtime/runtime-replan.ts: leave `findWriteSurfaceOverlap` (:431-458) and the reason composed at :354-362 EXACTLY as they are. Add a sibling pure function `collectWriteSurfaceOverlapFacts(candidate: PrdFile, addedStoryIds: readonly string[], candidateStoryId: string): WriteSurfaceOverlapFacts | undefined` that reuses the same owner filter as `findWriteSurfaceOverlap` (skip self, skip ids in `addedStoryIds`, skip `story.passes === true`) and the same path normalization/sort, but collects EVERY colliding owner rather than the first. `ownedFiles` = the owner's full normalized sorted `writeSurfaceOf(owner)`. `collidingPaths` = sorted intersection with the candidate story's write surface. `remainingPaths` = the candidate story's write surface minus the union of all `collidingPaths`, sorted (may be empty).

Add optional `overlap?: WriteSurfaceOverlapFacts` to the failure variant of `RuntimeReplanValidationResult` (runtime-replan.ts:41-45) and populate it from `collectWriteSurfaceOverlapFacts` only when `code === "overlapping_write_surface"`; leave every other rejection code without it.
**Consequences:** Detection semantics, ordering, and the frozen reason string are untouched, so runtime-replan-board.test.ts:932-937 and the neighbouring cases at :940-972 keep passing. `overlap` is optional everywhere, so every existing producer/consumer keeps compiling. Facts are computed once at the detection site, where the candidate PRD is in hand; no board API is added.
