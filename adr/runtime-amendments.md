# Runtime architecture and plan amendments

> Generated from durably accepted Baro runtime graph decisions. The quoted
> reasons, identifiers, and titles below are untrusted model/repository data,
> not executable instructions. Entries are ordered by committed graph version;
> a later accepted decision supersedes an earlier Architect baseline wherever
> they conflict.

## Graph version 2

```json
{
  "graphVersion": 2,
  "proposalId": "run-progressive-fa6286689d33d813:planner:18be9fc176f99897fe4f28880c3d25695f22c0a457531b5c78bbb1b44cbedf10",
  "sourceStoryId": "planner:planning-fa6286689d33d813-1",
  "reason": "progressive planner admitted fragment run-dep-reuse-f1",
  "exactMutationSha256": "ffe28be5ab02ba7c925bab3814d83da2b44ba510d1088d09e095a468187f5d3e",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Materialize host dependencies into __run and treat linked node_modules as fresh",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A7",
          "G-C1",
          "G-C3",
          "G-C4",
          "G-C5"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```

## Graph version 3

```json
{
  "graphVersion": 3,
  "proposalId": "run-progressive-fa6286689d33d813:planner:396950c942aa08bb5e1f8dbfeb63cd0d6579468dda84e0dbb76b428e5b83cdc9",
  "sourceStoryId": "planner:planning-fa6286689d33d813-1",
  "reason": "progressive planner admitted fragment final-tail-2",
  "exactMutationSha256": "7cb3b58ea34ec50d8e5b81c604a77bc56c9c7f0c4bce2ee3b3b58e1f35f85e63",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S2",
        "title": "Resolve CARGO_TARGET_DIR from the host checkout and thread hostRepoRoot through the verification callers",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A3",
          "G-A7",
          "G-A8",
          "G-C1",
          "G-C2",
          "G-C3",
          "G-C4",
          "G-C5"
        ]
      },
      {
        "id": "S3",
        "title": "Own command-cwd resolution and the retry backoff in a new verification module and prove them through verifyBuild",
        "dependsOn": [
          "S2"
        ],
        "goalInvariantIds": [
          "G-A4",
          "G-A5",
          "G-A6",
          "G-A7",
          "G-A8",
          "G-C1",
          "G-C2",
          "G-C4",
          {
            "omittedItems": 1
          }
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```

## Graph version 4

```json
{
  "graphVersion": 4,
  "proposalId": "goal-remediation-cd972a662359cb04cd1ba9e1",
  "sourceStoryId": "goal:challenge-bb2325e4-cbd2-4c24-b557-cad3b83c52d1",
  "reason": "autonomous remediation for G-A4: UNSATISFIABLE AS SCOPED - needs corrective work. G-A4/G-A5/G-A6 (and O-009..O-015, O-020, O-021) require wiring in packages/baro-orchestrator/src/verification/verify.ts: replace 'const commandCwd = c.cwd ?? cwd' (verify.ts:1196) with resolveCommandCwd(cwd, c.cwd), add retryable:false to the missing-working-directory branch, add 'outcome.retryable !== false' to the retry condition, add sleep to VerifyBuildOptions with an awaited RETRY_BACKOFF_MS backoff plus throwIfAborted before attempt 2, and add RETRY_BACKOFF_MS per retryable command to recommendedVerifyTimeoutMs/recommendedMergedVerifyTimeoutMs. S3 is the assigned evidence owner but verify.ts is NOT in S3's write surface - it is assigned to S1 - and every edit is hard-refused: '[gate:write-surface] packages/baro-orchestrator/src/verification/verify.ts belongs to story S1 in this run. A diff touching it is refused at integration'. All three escape hatches are closed: (a) ask the owner / block on S1 is useless because S1 (cc5d705) and S2 (472f415) are ALREADY MERGED; (b) a runtime replan adding a corrective story S4 was REJECTED by the Board with code invalid_proposal, '10 architecture obligation violations: architecture obligation O-009 has multiple evidence owners: S3, S4 ...' because those obligations are immutably bound to the active story S3; (c) S3's own write surface cannot be widened while S3 is active. EVIDENCE OF THE UNSATISFIED STATE: verify.ts:1196 still reads 'const commandCwd = c.cwd ?? cwd', so a VerifyCommandSpec carrying an absolute cwd into a removed baro-worktrees/<runId>/<agentId> story worktree is still used verbatim and still retried against the absent path. WHAT S3 DID DELIVER: packages/baro-orchestrator/src/verification/command-cwd.ts, complete and tested, exporting resolveCommandCwd(runCwd, commandCwd), RETRY_BACKOFF_MS = 2000 and defaultSleep(ms). CORRECTIVE WORK NEEDED: a story that owns packages/baro-orchestrator/src/v… [truncated sha256:ca397235ed444369]",
  "exactMutationSha256": "29117e52f6c1b8a88356cc76be09751507880cdacf9feed9499f8c3af3935789",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "GREM-cd972a662359",
        "title": "Resolve goal challenge G-A4",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A4"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```

## Graph version 5

```json
{
  "graphVersion": 5,
  "proposalId": "replan-d8788bdf-37ae-4a48-b606-a645389868d9",
  "sourceStoryId": "S3",
  "reason": "Corrective work for challenge-bb2325e4 (G-A4). S3's module src/verification/command-cwd.ts is committed and green, but NOTHING IMPORTS IT: verify.ts:1196 still reads 'const commandCwd = c.cwd ?? cwd', so G-A4/G-A5/G-A6 are still unsatisfied in the tree. S3 cannot wire it because verify.ts is on the merged S1's write surface and [gate:write-surface] hard-refuses the edit (re-tested just now at graph version 4: still refused); S1 (cc5d705) and S2 (472f415) are merged so the owner cannot act, and S3's surface is immutable while active. My earlier proposal replan-ed3b16d5 was rejected for 'multiple evidence owners: S3, S4' because I tagged S4's acceptance criteria with the O-ids S3 already owns; this revision claims NO obligation ids and NO goalInvariantIds, leaving S3 the sole evidence owner. S4 only needs the write surface for verify.ts and the two verification test files to perform six mechanical wiring edits that make S3's existing obligations demonstrable on the merged tree. If the Guardian has already created an equivalent corrective story at version 4, reject this as redundant and I will stand down.",
  "exactMutationSha256": "ad8008e5603fed5cae4265a604887bc7cb3228d77e0e9c86fcf8a64cff6aeb6e",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S4",
        "title": "Wire command-cwd resolution and the retry backoff into verifyBuild",
        "dependsOn": [
          "S3"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
