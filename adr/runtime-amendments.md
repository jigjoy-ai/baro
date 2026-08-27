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
  "proposalId": "run-progressive-24fd886617dada09:planner:f0bd81becb6aad432c1d32c2451d6369778fb6a2241c694afb59a0e89f7cc9d2",
  "sourceStoryId": "planner:planning-24fd886617dada09-1",
  "reason": "progressive planner admitted fragment prd-persist-preserving-foundation",
  "exactMutationSha256": "7674ce90f52a8e53e827e8ff50a46add924d1498ca0ddb03066d40507643bf38",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Add persistPrdPreserving read-merge-write helper to prd.ts",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-C1",
          "G-C2",
          "G-C4",
          "G-C6",
          "G-C7",
          "G-C9"
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
  "proposalId": "goal-remediation-9c5feaf310938c278229a2e5",
  "sourceStoryId": "goal:challenge-089607ea-7899-4b62-87e1-75927f91f990",
  "reason": "autonomous remediation for G-A1: G-A1 clause (3) is unsatisfiable inside S1's write surface. It requires the interleaving sequence createPrdStatusWriter({prdPath}).onStoryMerged(story1,sha) -> persistPrdPreserving(path, stale snapshot) -> createPrdStatusWriter({prdPath}).onStoryFailed(story2) to leave all three fields correct on disk, INCLUDING top-level goalFingerprint. Repository evidence: prd-status-writer.ts defaults to load=loadPrd (line 33) and save=savePrdAtomic (line 34); loadPrd->normalizePrd rebuilds a whitelist literal (prd.ts:282-291) with no goalFingerprint member. Verified output: 'goalFingerprint on disk after onStoryMerged: undefined'. The FIRST status-writer call in the sequence already erases goalFingerprint, before persistPrdPreserving ever runs, so no correct implementation of the helper can make clause (3) pass with bare defaults. Corrective work needed (owned by nobody today): change the save default in packages/baro-orchestrator/src/execution/prd-status-writer.ts:34 from savePrdAtomic to persistPrdPreserving -- a one-line change that leaves its load-modify-write ownership mechanism (G-C1) fully intact, but which ADR-002 forbids and O-017 asserts must stay byte-identical. G-C1 and G-A1 are in direct conflict as written. S1 is delivering the helper, the main.ts re-export and cases (a),(b),(d) plus the lost-update half of (c) in full, and pins the residual erasure with an explicit assertion.",
  "exactMutationSha256": "382aea59e2fbe6850f1142d2852ace4f1ec39e39aeed0e68b18a1584dbd1d892",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "GREM-9c5feaf31093",
        "title": "Resolve goal challenge G-A1",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1"
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
  "proposalId": "run-progressive-24fd886617dada09:planner:7008249b2b8e1cdb64b30767e1856a088cd0b04e2af5de371e5d819a391d3e5b",
  "sourceStoryId": "planner:planning-24fd886617dada09-1",
  "reason": "progressive planner admitted fragment final-1ce2d8a775d5d741ce9ca6269a94009b3a137afb9b2c1a1ef2d5f342701c07c0",
  "exactMutationSha256": "1e8a46be78a2df9436e36905a7cf852a466e8a09849b264716784ff381fe4261",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S2",
        "title": "Route all full-file prd.json writers through persistPrdPreserving",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A6",
          "G-C1",
          "G-C2",
          "G-C3",
          {
            "omittedItems": 5
          }
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
  "proposalId": "run-progressive-24fd886617dada09:dependency-block:block-645f55f8-5a31-4b9b-8a65-c54b863df8b9",
  "sourceStoryId": "GREM-9c5feaf31093",
  "reason": "GREM's whole corrective fix is one line: prd-status-writer.ts:34 'save = savePrdAtomic' -> 'save = persistPrdPreserving'. That symbol does not exist on this branch (grep -rn persistPrdPreserving packages/baro-orchestrator/src/ returns nothing on main), and creating it is S1's declared write surface (ADR-005 Story 1 writes src/prd.ts + src/main.ts). S1 is mid-flight right now: its worktree already has 'export function persistPrdPreserving(' at packages/baro-orchestrator/src/prd.ts:262, uncommitted, so main..S1 is still empty. If GREM proceeds now it must either (a) import a non-existent export, leaving a tree that fails the build-before-commit gate and cannot run its own regression test, or (b) implement persistPrdPreserving itself in src/prd.ts, which guarantees a merge conflict with S1 at the same hunk and breaks O-028 (Story 1's diff must equal its declared writes). Both are the 'temporary/stale code' case. GREM is not blocked on uncertainty: the defect is already reproduced (goalFingerprint 'abc123' -> undefined after a single bare-default onStoryMerged) and the fix is decided. It is blocked purely on ordering -- GREM should be sequenced AFTER S1 integrates, then it is a one-line edit plus one new test file (test/execution/prd-status-writer-preservation.test.ts) proving G-A1 clause (3) end-to-end. Requesting suspension so GREM resumes on a tree that has the helper.",
  "exactMutationSha256": "d1010f22a976b583ef1c0af77eaaa9e0b0a5e163f9c106cb2e1376949ef53bc0",
  "mutationSummary": {
    "addedStories": [],
    "removedStoryIds": [],
    "modifiedDeps": {
      "GREM-9c5feaf31093": [
        "S1"
      ]
    }
  }
}
```

## Graph version 6

```json
{
  "graphVersion": 6,
  "proposalId": "replan-2f1a8b2e-1b15-481e-b6f4-bf575d495099",
  "sourceStoryId": "S1",
  "reason": "ADR-002 asserts that routing prd-status-writer through the helper would be a no-op at best; repository evidence disproves it (disputed separately). Its save default is the blind savePrdAtomic and its load default is the stripping loadPrd, so it erases the Rust goalFingerprint stamp on its FIRST write, before conductor / collective-board / orchestrate ever run. No story in the current plan owns that file (S1: prd.ts, main.ts, new test; S2: conductor.ts, runtime-replan-coordinator.ts, collective-board.ts, orchestrate.ts, two new tests), so G-A1 clause 3 (interleaving leaves all three fields correct with the writer at its documented defaults) and G-A3 (goalFingerprint present after progressive plan-persist plus conductor persist) are unreachable for any run that also records story status. One line in one file closes it without touching the read-modify-write ownership mechanism G-C1 protects.",
  "exactMutationSha256": "79adb076cd99bc5c1a165660a6d177024e3e4e5851c919be6e3470cc6aa612c9",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S3",
        "title": "Route prd-status-writer default save through persistPrdPreserving",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-A3",
          "G-C1"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
