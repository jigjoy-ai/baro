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
  "proposalId": "run-progressive-a349fd762fb0cdf3:planner:65b9303747cd767c9d812f5ad522a0f3969afbe655559dd8e4ff17d569757703",
  "sourceStoryId": "planner:planning-a349fd762fb0cdf3-1",
  "reason": "progressive planner admitted fragment turn-review-and-tokenize-fixes-2",
  "exactMutationSha256": "e1ceeb2d334c14427f5f3c2a39acd04eed2a54df34b738233d436541e588ceeb",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Latest terminal candidate wins over pending review wait",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A11",
          "G-C1",
          "G-C4",
          {
            "omittedItems": 3
          }
        ]
      },
      {
        "id": "S2",
        "title": "Unwrap paired-quote tokens in declared-verification tokenize",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A6",
          "G-A7",
          "G-A8",
          "G-A9",
          "G-A10",
          "G-A11",
          "G-C2",
          "G-C3",
          {
            "omittedItems": 5
          }
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
