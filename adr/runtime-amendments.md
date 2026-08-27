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
  "proposalId": "run-progressive-9a5bf99960ee22db:planner:fb36d22ad0dc8ab72a3c5ad3772c87aff6f596495fe9af958af14dd14749d7f5",
  "sourceStoryId": "planner:planning-9a5bf99960ee22db-1",
  "reason": "progressive planner admitted fragment resume-loop-prefix-1",
  "exactMutationSha256": "afd776a61740adc7a34e649a61684feab103a51bac119017fd2a1154f43db537",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Headless goal-fingerprint stamp: audit persist sites and prove with inline Rust tests",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A6",
          "G-C1",
          "G-C2",
          "G-C4"
        ]
      },
      {
        "id": "S2",
        "title": "Unconditional PrdStatusObserver wiring plus activity-event reporting in the prd-status writer",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A6",
          "G-C1",
          "G-C2",
          "G-C4",
          "G-C7"
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
  "proposalId": "run-progressive-9a5bf99960ee22db:planner:8871363460b1c95b9721f6e15d92a465f00c323aae00cfb866182a78d56de2f2",
  "sourceStoryId": "planner:planning-9a5bf99960ee22db-1",
  "reason": "progressive planner admitted fragment final-32416e10ac1abbcd2bd804fa87c0d7070dc7842550d5ccea7bbd45ac35ebd2ad",
  "exactMutationSha256": "572c0ddd85b37d19255df134cf76bc69a0fdeab284e2534dfe201a2f58bd5b2c",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S3",
        "title": "Observer-to-resume loop integration test over a real on-disk prd.json",
        "dependsOn": [
          "S2"
        ],
        "goalInvariantIds": [
          "G-A3",
          "G-A5",
          "G-C1",
          "G-C2",
          "G-C3",
          "G-C4",
          "G-C5",
          "G-C6"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
