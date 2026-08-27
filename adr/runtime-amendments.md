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
  "proposalId": "run-progressive-49c79918885873bd:planner:4143e23b0c2ca4131cf9b339b69cdbc2be6f57ec62eec3eb580b6432ea98b746",
  "sourceStoryId": "planner:planning-49c79918885873bd-1",
  "reason": "progressive planner admitted fragment resume-registry-hygiene-1",
  "exactMutationSha256": "569f1d53ee8e87f0ef72596f149d4eb4bcf5fe4791703f0f15003c9a3234bb14",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Carry the resume decision on the orchestrator child's argv",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-C1",
          "G-C3",
          "G-C5",
          "G-C6"
        ]
      },
      {
        "id": "S2",
        "title": "Route the cli.ts resume gate through a pure resume-mode helper",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A3",
          "G-A4",
          "G-C1",
          "G-C2",
          "G-C3",
          "G-C5",
          "G-C6",
          {
            "omittedItems": 1
          }
        ]
      },
      {
        "id": "S3",
        "title": "Delete the registry record once baro stop confirms the process is dead",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A5",
          "G-A6",
          "G-A7",
          "G-C4",
          "G-C6",
          "G-C7"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
