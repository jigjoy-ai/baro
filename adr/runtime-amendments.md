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
  "proposalId": "run-progressive-b7503c5d75c0c48c:planner:35d4e9ff90dd90c6d37f918eabe62d4ed9d0f6ea68b5b56cb746f023bbc66d47",
  "sourceStoryId": "planner:planning-b7503c5d75c0c48c-1",
  "reason": "progressive planner admitted fragment planner-finalization-obligation-visibility-1",
  "exactMutationSha256": "49922a9949a8c8124fca99626bf805606bb2ce336dcd1e9886f1e5dcfbe89a5e",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Structured unowned-obligation ids, planner repair prompt, and fail-closed finalization retry loop",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A3",
          "G-A4",
          "G-A6",
          "G-C1",
          "G-C2",
          "G-C3",
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

## Graph version 3

```json
{
  "graphVersion": 3,
  "proposalId": "run-progressive-b7503c5d75c0c48c:planner:3edea1b0cf0a83abf888d9a7cd6f249454ffe82b5d7e3d58ce1e07bc64ed4bb3",
  "sourceStoryId": "planner:planning-b7503c5d75c0c48c-1",
  "reason": "progressive planner admitted fragment final-49a54e1c3c57a1f895a5d61175e03ef9ae50f7e02501920954a6508e69cc2b4d",
  "exactMutationSha256": "be765f7fabf2ebe90c5569c6bc580e36a32d0f5f298bcf826059b794cc7d69a4",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S2",
        "title": "Concrete unowned-obligation ids on the fragment publish receipt and a per-admission stderr announcement",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-A5",
          "G-C1",
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
