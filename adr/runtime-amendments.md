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
  "proposalId": "run-progressive-be679acf414642fb:planner:fafd016412cbd3b7523c061305b08083c4052a2d50623d950302b66eac51707f",
  "sourceStoryId": "planner:planning-be679acf414642fb-1",
  "reason": "progressive planner admitted fragment final-c8f0a23be1a4335cdfbfc4eaada2b5050b34814ed731f9a9ce7350d0002ea39a",
  "exactMutationSha256": "c8e7b8f5570d385940a73bfa19533dd220f433e83f560a262d839a530386ea8f",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Fail closed on host-assigned correlation fields in shared contract normalization and its call sites",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A6",
          "G-C1",
          "G-C2",
          {
            "omittedItems": 6
          }
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
