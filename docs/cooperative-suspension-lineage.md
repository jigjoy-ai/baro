# Cooperative suspension and candidate lineage

Why a story resumed after cooperative suspension can produce Critic-accepted
work that `sealedMergeTarget` correctly refuses for lineage, and why that
refusal could leave nothing behind for `prepareConflictRetry`.

All citations are to the tree this diagnosis was written against (S1, before
any behaviour change landed in `packages/baro-orchestrator/src/integration/worktree.ts`).

## 1. Observed call chain: WorkBlocked → post-resume mergeBack

1. The worker declares a dependency block. The bridge publishes it:
   `src/execution/collaboration-bridge.ts:1370` (`publishWorkBlocked`) →
   `:1420` `this.publish(WorkBlocked.create(correlation))`.
2. The Board accepts it from the dependency authority
   (`src/execution/collective-board.ts:616-622`) and handles it in
   `onWorkBlocked` (`:1123`).
3. The story factory drives cooperative quiescence:
   `src/market/story-factory.ts:807` `suspensionPromise = exec.suspend(data.blockId)`.
   The certificate itself (`src/harness/cooperative-suspension.ts`) is pure —
   it touches no git state and no base SHA.
4. Quiescence ends in a lease release with reason `dependency_blocked`
   (`collective-board.ts:625-632`) → `onDependencyLeaseReleased` (`:1312`).
   That records a dependency recovery context (`:1347-1352`) and emits
   `WorkspaceCleanupRequested` with `preserveForRecovery: true`
   (`:1361-1370`).
5. `GitCoordinator` handles that request (`src/integration/git-coordinator.ts:196-245`)
   and calls `cleanupFailedStory(storyId, true)` (`:235`, defined at `:511-521`),
   which is `worktrees.cleanupFailed(storyId, true)`.
6. `WorktreeManager.cleanupFailed` (`src/integration/worktree.ts:296`) takes the
   suspension boundary apart: it marks the story preserved (`:389`), commits
   leftover work (`:390`), mints the immutable ref
   `baro-recovery/<runId>/<storyId>/<n>` (`:391`, `createRecoveryBranch` at
   `:981-1005`), then calls `releaseLogicalStory` (`:393`) which removes the
   worktree, **deletes `baseShas`** (`:1032`), deletes the story branch, and
   **removes the story from `preserved`** (`:1042`).
7. The coordinator reports the preserved branch on `WorkspaceCleanupCompleted`;
   the Board stores it on the recovery context
   (`collective-board.ts:823-831`).
8. Resume is ordinary re-offering. The preserved branch reaches the resumed
   agent **only as prompt prose**: `collective-board.ts:2950-2956` →
   `buildRecoveryPromptSection` (`src/planning/domain/story-offer-prompt.ts:69-84`),
   whose text is “The rejected attempt is preserved at `<branch>`. Inspect
   `git diff HEAD...<branch>` … then reapply its intent … Do not merge or
   cherry-pick the backup wholesale.”
9. Spawning the resumed story recreates the worktree with the ordinary
   creation path: `src/market/story-factory.ts:957-958`
   `await this.opts.worktrees.create(req.storyId)`.
10. On Critic PASS, `GitCoordinator.onStoryPassed` calls
    `worktrees.mergeBack(storyId, candidateSeal)`
    (`git-coordinator.ts:383-386`), which runs `sealedMergeTarget`
    (`worktree.ts:505-552`) before merging.

There is **no host-owned rebase or restore anywhere on this path**. The only
`rebase` in `src/` is `git pull --rebase=merges` in `src/integration/git.ts`.

## 2. Proven cause

`baseShas` is written in exactly one place: `worktree.ts:179`
`this.baseShas.set(storyId, baseSha.trim())`, inside `create()`, from the
`git rev-parse HEAD` read at `:165-167`, after `create()` has cleared the
story's prior logical state at `:157-159`
(`paths.delete` / `baseShas.delete` / `preserved.delete`). `sealedMergeTarget`
reads that value at `:515` and refuses the candidate at `:529-534` when
`git merge-base --is-ancestor <baseSha> <candidateHEAD>` (`:524-528`) fails.

The proven cause is therefore:

> At the suspension boundary the host **discards** the story worktree and its
> recorded creation SHA (`worktree.ts:393` → `:1032`, `:1042`) and keeps the
> pre-suspension commits only on the immutable `baro-recovery/<runId>/<storyId>/<n>`
> ref minted at `worktree.ts:391`. On resume the host recreates the worktree
> from scratch at the *current* run-branch HEAD (`story-factory.ts:957-958` →
> `worktree.ts:165-172`) and records that new, post-integration commit as the
> creation SHA at `worktree.ts:179`. Nothing host-owned ever replays the
> preserved commits onto that new base: the only thing carried across the
> boundary is prompt prose naming the recovery branch
> (`collective-board.ts:2950-2956` → `story-offer-prompt.ts:76-84`).
> Restoration is thus delegated to the agent, and any way the agent restores
> its own pre-suspension history — `git reset --hard <recovery-branch>`,
> checking that branch out, or otherwise grafting it — moves the candidate onto
> a history rooted **before** the recorded creation SHA. `merge-base
> --is-ancestor` at `worktree.ts:524-528` then fails and `:529-534` refuses the
> candidate with `reviewed candidate history no longer descends from its
> creation SHA for story <id>`. The refusal is correct: the mover was not the
> host. The defect is that the host left no legitimate way to move.

The recovery-material half of the failure is proven at the same two sites:

- `mergeBack`'s outer catch (`worktree.ts:492-499`) adds the story to
  `preserved` **only** when the failure is a repository-command timeout. A
  `sealedMergeTarget` lineage refusal is not a timeout, so it propagates with
  `preserved` still unset — and `preserved` was already emptied for this story
  by the suspension-boundary `releaseLogicalStory` (`:1042`).
- `GitCoordinator` then calls `worktrees.prepareConflictRetry(storyId)`
  (`git-coordinator.ts:396`), whose guard `!this.preserved.has(storyId)`
  (`worktree.ts:236-240`) throws
  `story <id> has no preserved worktree to recover` — a message that cannot
  distinguish “this story never had preserved material” from “its material was
  preserved at the suspension boundary and then released”.

## 3. Hypothesis verdict

The goal's stated hypothesis was: *resume rebases or recreates the worktree
onto the post-GREM integration base while `baseShas` retains the pre-suspension
value*.

Hypothesis: PARTIAL

- Confirmed: resume **recreates** the worktree onto the post-integration base
  (`story-factory.ts:957-958` → `worktree.ts:165-172`).
- Refuted: `baseShas` does **not** retain the pre-suspension value. `create()`
  deletes it at `:158` and rewrites it at `:179` from the fresh
  `git rev-parse HEAD`. The drift runs the other way: the recorded base moves
  forward with the run branch while the story's real work stays behind on the
  `baro-recovery` ref, and only the (untrusted) agent can move it forward.

The fix is therefore stated as an invariant over `baseShas` rather than as a
repair of the hypothesised code path: whenever the host legitimately re-bases
or recreates a worktree at the suspension boundary, it must move the history
and the recorded creation SHA in one host-owned, gate-held step.

## 4. Chosen host-owned seam

`WorktreeManager` (`src/integration/worktree.ts`). `baseShas` is private to it
and written in exactly one method, so it is the only place where a history move
and a base write can be made atomic with respect to every other git operation
(the shared `GitGate`).

The seam is a new public `resumeFromSuspension(storyId, { restoreFrom })`:

- the whole body runs inside a single `this.gate.acquire()` block, like
  `create()`;
- it reads the run-branch base once (`git rev-parse HEAD` in `repoRoot`),
  recreates the worktree at that commit, and — when `restoreFrom` is given —
  replays the preserved commits onto it with
  `git rebase --onto <newBaseSha> <mergeBase> <restoreSha>` run in the
  worktree, aborting and failing closed on any conflict or non-zero exit;
- `this.baseShas.set(storyId, sha)` happens in that same critical section,
  after the worktree exists and after the replay, before the gate is released;
- `baseShas.set(...)` exists in exactly two methods after this change:
  `create()` and `resumeFromSuspension()`. No agent-reachable path can move its
  own recorded base, so `sealedMergeTarget`'s lineage refusal keeps exactly its
  present meaning for every non-host history change.

Two supporting obligations land at the same seam:

- **Recovery material.** Every path that removes or forgets a preserved
  worktree first mints/records an immutable `baro-recovery/...` ref, and
  `prepareConflictRetry` returns a recorded ref that still resolves when no
  live preserved worktree remains. `restoreFrom` is resolved to a commit SHA
  before the rebase so the named recovery ref is never moved by the replay.
- **Diagnosable refusal.** The `no preserved worktree` throw keeps its prefix
  verbatim and gains `: never preserved` or
  `: preserved and later cleaned (reason=<reason>, recoveryRef=<ref|none>)`.
  Maintenance obligation: any future site that drops preserved state must also
  record its disposition in `preservedHistory`, otherwise it degrades to the
  `never preserved` wording.

## 5. Note on the recorded ADR fact about test assertions

ADR-005 states that `packages/baro-orchestrator/test/integration/worktree.test.ts:310`
and `:362` assert the exact `no preserved worktree to recover` string. They do
not: `:310` is `assert.match(backup, new RegExp(...))` and `:362` is
`assert.notEqual(git(repo, "branch", "--list", ...), "")`. The string appears
nowhere in that file — its only literal occurrences outside `worktree.ts` are
the stubs at `test/integration/git-coordinator.test.ts:551` and `:576`, which
throw their own message and are unaffected. `worktree.test.ts` therefore needs
no edit for the split wording.
