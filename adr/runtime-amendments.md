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
  "proposalId": "run-progressive-ae3da03c98bec016:planner:43ab458358ba2aa7a5cfeefeb6ffa93583a364980b48af3303217c7d020ecb2d",
  "sourceStoryId": "planner:planning-ae3da03c98bec016-1",
  "reason": "progressive planner admitted fragment resume-fail-closed-prefix-1",
  "exactMutationSha256": "e45d20545487ea699152b65719a7d723b51741ce17a2bbe7afe95e4524fdb73c",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Pure resume_guard decision module",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A2",
          "G-A3",
          "G-A5",
          "G-A7",
          "G-C2",
          "G-C3",
          "G-C7",
          "G-C9"
        ]
      },
      {
        "id": "S2",
        "title": "Fresh-plan write barrier and its three main.rs call sites",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A3",
          "G-A4",
          "G-A6",
          "G-A8",
          "G-C1",
          "G-C5",
          "G-C7",
          "G-C8",
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
