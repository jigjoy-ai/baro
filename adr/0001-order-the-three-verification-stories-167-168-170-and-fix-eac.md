# ADR-0001: Order the three verification stories #167 -> #168 -> #170 and fix each one's write surface

**Status:** Accepted
**Context:** All three touch verify.ts, and their regions overlap: #167 needs boundedDeclaredCommands (:775-811) plus the skipped/incomplete branches of runCmd (:1247, :1271-1283), #168 needs the missing-cwd branch (:1261-1269) in the same function, #170 needs the retry loop (:1394-1465) and the result assembly (:1446-1461) that #168's classification feeds. Splitting verify.ts by line range across parallel agents would conflict on the same function bodies; merging them is a stated non-goal. Sequential ordering costs wall-clock but is the only conflict-free option for a 1468-line monolith.
**Decision:** Plan exactly three ordered stories, each starting from the previous one's merged tree: STORY-167 first, then STORY-168, then STORY-170. Only the currently-running one of the three may edit packages/baro-orchestrator/src/verification/verify.ts.
Exclusive write surfaces:
- STORY-167: src/verification/declared-verification.ts, src/verification/node-test-script.ts, src/verification/declared-test-budget.ts, new src/verification/declared-credit.ts, and the verify.ts regions boundedDeclaredCommands (:752-811), createVerifyPlan declared-translation overflow (:833-858) and the runCmd incompleteReason/containment branches (:1247-1283).
- STORY-168: src/verification/command-cwd.ts, src/integration/integration-worktree.ts, src/execution/worktree.ts (cleanup gating only), src/orchestrate.ts (verification call sites only), and the verify.ts missing-cwd branch (:1261-1269).
- STORY-170: new src/verification/failure-classifier.ts, new src/verification/failure-signals.ts, src/events/verification.ts, and the verify.ts retry loop plus result assembly (:1394-1465).
No story edits src/tui-protocol.ts or any file under crates/.
STORY-165 (crates/baro-tui only) and STORY-169 (containment) have no overlap with these three and may run in parallel with them.
**Consequences:** The three verification stories are a chain in the DAG, not a fan-out. STORY-170 can rely on STORY-168's environment classification for a vanished cwd already existing. Any agent that finds it needs a verify.ts line outside its listed region must stop and report rather than widen its diff.
