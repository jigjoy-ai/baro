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
  "proposalId": "run-progressive-2a69550a87d46bc5:planner:738c47057321ca55ec3c76f08352a44e89fcf20e311628fd6c45c27d473d18c4",
  "sourceStoryId": "planner:planning-2a69550a87d46bc5-1",
  "reason": "progressive planner admitted fragment verification-gaps-59-62-triple",
  "exactMutationSha256": "156f50fa389ef919253c8a2b61df8b9ab9c83382052f0d226e1c63d2914ac8fc",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Accept literal '--import tsx' loader prefix in translateNode",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-C1",
          "G-C2",
          "G-C4",
          "G-C5",
          "G-C6"
        ]
      },
      {
        "id": "S2",
        "title": "Carry retry evidence to the TUI wire via one exported mapper",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A2",
          "G-C4"
        ]
      },
      {
        "id": "S3",
        "title": "Make the shared-budget architect test deadline-dominant by construction",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A3",
          "G-C3",
          "G-C4"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
