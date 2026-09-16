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
  "proposalId": "run-progressive-a5a59543c8470291:planner:44db32c30ac4cf279e3f5a29122ca539803f4e98b169c3d7ae7e01f43b9c3661",
  "sourceStoryId": "planner:planning-a5a59543c8470291-1",
  "reason": "progressive planner admitted fragment language-mirroring-rule-f1",
  "exactMutationSha256": "c1a636933b5001d6c6dfea33ab5db80bd82f409bcaac4392598e6084620990c1",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Add language-mirroring rule to operator systemPrompt, export it, and test it",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-C1",
          "G-C2",
          "G-C3",
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
