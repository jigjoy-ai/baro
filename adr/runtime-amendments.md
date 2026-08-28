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
  "proposalId": "run-progressive-33fca65ace079aa2:planner:a8eb950a9412640e1b72f4255ba391ff323ff1dbb7f7ec153e7defc38af16f11",
  "sourceStoryId": "planner:planning-33fca65ace079aa2-1",
  "reason": "progressive planner admitted fragment contract-drift-tolerance-prefix-1",
  "exactMutationSha256": "9e0d419d4863ca1fae1a5dd185d9764f3e7a80811435ad7963608c1ef5866519",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Add shared contract-normalization leaf module",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-C2",
          "G-C3",
          "G-C8"
        ]
      },
      {
        "id": "S2",
        "title": "Normalize, skip-absent and accumulate defects in the constraintPredicates appendix",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A8",
          "G-C2",
          "G-C3",
          {
            "omittedItems": 1
          }
        ]
      },
      {
        "id": "S3",
        "title": "Normalize obligation drafts and emit a full-defect repair string in the segment compiler",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-A5",
          "G-A8",
          "G-C2",
          "G-C5",
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
  "proposalId": "run-progressive-33fca65ace079aa2:planner:10d1b515e4ecbdd369ab00b7d6f70de739d9d740c9221d7e6d4e35bacae43aaf",
  "sourceStoryId": "planner:planning-33fca65ace079aa2-1",
  "reason": "progressive planner admitted fragment final-fccab12b4b7192de37181a567b41bb2271925a59e3cc04c15fa1ad955f457781",
  "exactMutationSha256": "0dd8e16288729bfece1b31d47cbab7f2f99ce8fd2ed69fdb8d769cbeadda229c",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S4",
        "title": "Normalize the architect outcome record, evidence and question entries",
        "dependsOn": [
          "S1",
          "S2"
        ],
        "goalInvariantIds": [
          "G-A6",
          "G-C4"
        ]
      },
      {
        "id": "S5",
        "title": "Full-defect repair prompt and richer exhaustion message in the bus session",
        "dependsOn": [
          "S1",
          "S4"
        ],
        "goalInvariantIds": [
          "G-A6",
          "G-A7",
          "G-C5",
          "G-C6",
          "G-C8"
        ]
      },
      {
        "id": "S6",
        "title": "Wire the stderr note sink and outcome schema summary in run-architect",
        "dependsOn": [
          "S4",
          "S5"
        ],
        "goalInvariantIds": [
          "G-A8",
          "G-C1",
          "G-C7",
          "G-C8",
          "G-C9"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
