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
  "proposalId": "run-progressive-5f68f916f59b3cc6:planner:27eeec0f7acfde251f9da99528f78c4fe3181473882094ded476dcd66c6af4f2",
  "sourceStoryId": "planner:planning-5f68f916f59b3cc6-1",
  "reason": "progressive planner admitted fragment verification-chain-prefix",
  "exactMutationSha256": "4a0c5639b19b101a4a4b9f55766a483410469125c33bd82a1289e4349e081828",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "#167: runner-flag allowlist, dedup-before-budget, and declared-requirement crediting",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A7",
          "G-C1",
          "G-C4",
          "G-C5",
          "G-C6"
        ]
      },
      {
        "id": "S2",
        "title": "#168: resolve verification cwd at spawn in the integration worktree and gate story-worktree cleanup",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-C3",
          "G-C5",
          "G-C7",
          "G-C8"
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
  "proposalId": "run-progressive-5f68f916f59b3cc6:planner:5e675c37548f10a3bb53163a6759c987764782b91c1e9684f8e27d310b948fd5",
  "sourceStoryId": "planner:planning-5f68f916f59b3cc6-1",
  "reason": "progressive planner admitted fragment final-tail-2",
  "exactMutationSha256": "0be30ec0f223d9394dab422cbca4b880bd2149b7ef6aacf81cab436e3bb98e8f",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S3",
        "title": "#170: classify the first failure tail and drive the retry, evidence and run event from it",
        "dependsOn": [
          "S2"
        ],
        "goalInvariantIds": [
          "G-A3",
          "G-A6",
          "G-A7",
          "G-C1",
          "G-C2",
          "G-C3",
          "G-C4",
          "G-C8"
        ]
      },
      {
        "id": "S4",
        "title": "#165: scope the 8000-character limit to the interactive prompt and accept long --goal-file goals",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A4",
          "G-A6",
          "G-A7",
          "G-C9"
        ]
      },
      {
        "id": "S5",
        "title": "#169: extract shell containment, enforce it in the Claude hook, and register the gate",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A5",
          "G-A6",
          "G-C2",
          "G-C10"
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
  "proposalId": "replan-a57280e0-8c16-41be-a301-01ddd5274612",
  "sourceStoryId": "S3",
  "reason": "G-A3/G-C8 require the verification retry to be DECIDED by the classified first-failure tail (regression: no retry; environment: remedy then one retry; time-ceiling: one retry with the ceiling lifted). S3 owns and shipped that policy in src/verification/failure-classifier.ts (decideRetry) with tests, but the ONLY enforcement point is verifyBuild's retry loop in packages/baro-orchestrator/src/verification/verify.ts, which ADR-001/O-021 assigned to STORY-170 while S3's ENFORCED write surface lists verify.ts as owned by S1 (already merged). S3's instructions require it to report rather than edit outside its surface, and VerifyBuildOptions exposes no seam that can gate the retry from outside: the condition at verify.ts:1445-1452 reads only outcome.status, outcome.retryable, c.preflightFailure and isRunLevelCommand(c). Without this follow-up story nobody owns verify.ts and a regression tail keeps being retried unconditionally, leaving the retry half of G-A3 unsatisfied.",
  "exactMutationSha256": "13c1f43c216f2cdccb3340f234cf0f2523811ec8ec8674da53f586e12adec908",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S6",
        "title": "#170 follow-up: drive verifyBuild retry loop and result assembly from decideRetry",
        "dependsOn": [
          "S3"
        ],
        "goalInvariantIds": [
          "G-A3",
          "G-C8"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
