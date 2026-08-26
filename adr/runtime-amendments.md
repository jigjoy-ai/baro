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
  "proposalId": "run-progressive-aa22fe4d08cb3014:planner:1ac8b302ee43aafe5412bb547e49519fbba6d522397d6a83c8ddc83185659e47",
  "sourceStoryId": "planner:planning-aa22fe4d08cb3014-1",
  "reason": "progressive planner admitted fragment tui-flush-and-run-diff-cap-1",
  "exactMutationSha256": "12d6ec5405cac548ffed7e73615cd1044cd18ba92d275cfeb870995e07f3f58a",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "stdout flush on exit",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A5",
          "G-A6",
          "G-C1",
          "G-C2",
          "G-C3",
          "G-C4",
          {
            "omittedItems": 6
          }
        ]
      },
      {
        "id": "S2",
        "title": "run diff byte cap",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A3",
          "G-A4",
          "G-A5",
          "G-C1",
          "G-C6",
          "G-C7",
          "G-C9",
          "G-C11",
          {
            "omittedItems": 2
          }
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
