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
  "proposalId": "run-progressive-c86970d1f3deee37:planner:670418a97cb125f73dfe8edba3aa9c0dcbc18ed2f126b3029e558aa942d4912a",
  "sourceStoryId": "planner:planning-c86970d1f3deee37-1",
  "reason": "progressive planner admitted fragment obligation-canonicalization-core",
  "exactMutationSha256": "7a6687c53139e6746c706e2b1cb864624990231fd5814edeccbc36861318bc46",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Canonicalize obligation mappings inside the validator and collect all violations",
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
            "omittedItems": 4
          }
        ]
      },
      {
        "id": "S2",
        "title": "Wire emitObligationNote as onNote at the stream-capable validator call sites",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-C3"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
