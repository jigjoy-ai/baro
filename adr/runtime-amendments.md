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
  "proposalId": "run-progressive-d497b3daccc7bb61:planner:53901aa5bff5e5adb4879fbb0458c63b27b001fc9cf535c72c27cbd4a4db4a28",
  "sourceStoryId": "planner:planning-d497b3daccc7bb61-1",
  "reason": "progressive planner admitted fragment fix-104-fragment-1",
  "exactMutationSha256": "47a5070cd617c4f5e4b46be2f1b21690e7cb18494ee7ec7415ee414ea95feb44",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Carry write-surface overlap facts to the planner and render the three remedies",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A5",
          "G-C1",
          "G-C3"
        ]
      },
      {
        "id": "S2",
        "title": "Decide the final tail on a fresh board snapshot and compose the failure from it",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A3",
          "G-A4",
          "G-A5",
          "G-C2",
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
