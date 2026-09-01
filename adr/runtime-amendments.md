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
  "proposalId": "run-progressive-c5a052b55ef50891:planner:79855f645cbebd716a10f7cc38e5d0c36579e00fe152d77ce1acfec3e102cc5b",
  "sourceStoryId": "planner:planning-c5a052b55ef50891-1",
  "reason": "progressive planner admitted fragment invariant-coverage-prefix-1",
  "exactMutationSha256": "942bda258d89140efb8f5709f534d9ba6fba955781bee2aa5b3805e2a5da4177",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Invariant coverage report + canonicalization domain modules",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A3",
          "G-A4",
          "G-C2",
          "G-C5",
          "G-C7"
        ]
      },
      {
        "id": "S2",
        "title": "Publisher receipt, stderr line and warn sink for the invariant gap",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-A5",
          "G-C2"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
