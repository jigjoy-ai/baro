# ADR-0002: Remove the repositoryAuthority gate: join PrdStatusObserver in every run shape and accept authority-less merge events

**Status:** Accepted
**Context:** Root cause of the measured gap, established from code: orchestrate.ts:845 guards observer construction with `if (repositoryAuthority)` (= gitCoordinator ?? localRepositoryAgent, :838). gitCoordinator exists only when useGit (:701,:820); localRepositoryAgent only in collective mode without git (:833-836). In a legacy non-git run neither exists, so PrdStatusObserver is never created or joined and StoryMerged never reaches the writer — the writer is then reachable only through the legacy Conductor direct call at :1287 (failures only). The secondary narrowing is prd-status-writer.ts:109-111, which requires the source participant object to be identically the bound authority, so relays/forwarders re-emitting StoryMerged are dropped. Ordering (join at :848 vs RunStartRequest at :1801) is NOT the cause, and story-id mismatch is NOT the cause: ids travel verbatim from prd.userStories[].id (git-coordinator.ts:534-541, local-repository-agent.ts:49) and the only sanitization touches branch/dir names (worktree.ts:1473-1477). Both alternative candidates must be reported as ruled out.
**Decision:** Edit packages/baro-orchestrator/src/orchestrate.ts and packages/baro-orchestrator/src/execution/prd-status-writer.ts only.
orchestrate.ts: replace :844-849 with unconditional wiring —
```ts
const prdStatusWriter = createPrdStatusWriter({ prdPath: config.prdPath })
const prdStatusObserver = new PrdStatusObserver(prdStatusWriter)
if (repositoryAuthority) prdStatusObserver.setRepositoryAuthority(repositoryAuthority)
prdStatusObserver.join(env)
```
Keep the existing legacy direct call `prdStatusWriter.onStoryFailed(storyId)` at :1287 unchanged. Make no other change to orchestrate.ts.
prd-status-writer.ts, in PrdStatusObserver.onExternalEvent:
- When `this.repositoryAuthority` is set, keep the existing identity check (`source !== this.repositoryAuthority` -> return).
- When it is null, accept StoryMerged / StoryMergeFailed from any source.
- Add `private readonly settled = new Set<string>()`; before dispatching, compute `const key = `${event.name}:${event.data.storyId}`` (StoryMerged vs StoryMergeFailed give distinct keys) and return early if already present, else add it. This suppresses duplicate relays while still allowing a later merge to overwrite an earlier failure for the same story.
- Continue to handle exactly StoryMerged -> onStoryMerged(storyId, mergeCommitSha) and StoryMergeFailed -> onStoryFailed(storyId). Do NOT add new event types and do NOT change the emitters.
Writer body: before `load(prdPath)`, add a missing-file guard using `existsSync(prdPath)` (import from node:fs); when the file does not exist, return silently without saving, warning, or emitting — runs with no on-disk prd.json are legitimate and must stay quiet. All other load/save failures remain loud (see the reporting ADR).
Do NOT change selectResumeStories, prd.ts load/save, git-coordinator.ts, local-repository-agent.ts, or conductor.ts.
**Consequences:** Merged/failed status now reaches prd.json in legacy non-git, legacy git, and collective runs alike. The observer becomes source-permissive only when no authority exists, so git runs keep their single-authority guarantee. The PR description MUST state this root cause with the citations above and explicitly record that observer-join ordering and story-id mismatch were investigated and ruled out. This story owns orchestrate.ts and prd-status-writer.ts exclusively.
