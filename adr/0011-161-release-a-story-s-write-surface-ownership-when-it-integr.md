# ADR-0011: #161: Release a story's write-surface ownership when it integrates, using one shared overlap rule

**Status:** Accepted
**Context:** storyWriteSurface counts every peer as an owner, even peers that have already merged. Replan admission (findWriteSurfaceOverlap) already skips peers with passes===true, so the two rules disagree.
**Decision:** In src/execution/write-surface.ts:
- Export `isActiveOwner(story): boolean` = story.passes !== true.
- Export `surfacesOverlap(a: string[], b: string[]): string[]`, using normalized paths.
- storyWriteSurface puts a path in ownedElsewhere only for peers where isActiveOwner is true.
- runtime-replan.ts findWriteSurfaceOverlap and collectWriteSurfaceOverlapFacts use isActiveOwner and surfacesOverlap.

On StoryMerged, the board's onStoryMerged calls announceRevisedSurfaces so live leases drop the paths. Sentry's path→owner map deletes entries for the merged story.

No new diff-time gate is added. 'The gate' means the per-write gates: story-tools surfaceRefusal and the Claude hook.

Test: A owns F and passes; B is admitted with F; storyWriteSurface(B).ownedElsewhere has no F; surfaceRefusal lets B write F.
**Consequences:** The stale comments at write-surface.ts:8 and gate-registry.ts:79 about refusing at integration may be corrected in one line; nothing more.
