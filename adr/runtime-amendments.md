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
  "proposalId": "run-progressive-e6386e1797963a83:planner:1368e12a099aba7579a93673fc8e923094fe036f5b7a997b97b6debbbc2b46cc",
  "sourceStoryId": "planner:planning-e6386e1797963a83-1",
  "reason": "progressive planner admitted fragment final-45a732777a4e7869dc57830bb44c924cdc198bd918523de809cf580f1ef87658",
  "exactMutationSha256": "c87d55bd41d1f61f9fff29f590e8cd29ea36ab804c5686c8dfa6ae397a707a57",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Restore ceiling wording, route host timeout to the absolute ceiling, and make the first idle expiry CPU-measured",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A6",
          "G-A7",
          "G-A8",
          {
            "omittedItems": 11
          }
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
