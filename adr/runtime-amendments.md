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
  "proposalId": "run-progressive-fa9710c864f6214e:planner:115475d28ac6d3673186acf90e5f7d9c0d0e6c579f341e68b3a3e333cbcd27a5",
  "sourceStoryId": "planner:planning-fa9710c864f6214e-1",
  "reason": "progressive planner admitted fragment issue-107-gate-reliability-1",
  "exactMutationSha256": "b50c30c0f7e7b40f5bf4ee8c24dc62f07cda57a8874235bfd180defaae6a3f17",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Unique per-invocation worktree run roots via shared test fixture",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A7",
          "G-C4",
          "G-C6"
        ]
      },
      {
        "id": "S2",
        "title": "CPU-aware idle watchdog, absolute command ceiling, and announced run-level retry",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A6",
          "G-C1",
          "G-C2",
          "G-C3",
          "G-C5",
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
