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
  "proposalId": "run-progressive-2593fd50c8203c06:planner:b5e81c10a839cdc1a1e2cae149bd90b1e5b6f0acdf3055653d19a05549ffca23",
  "sourceStoryId": "planner:planning-2593fd50c8203c06-1",
  "reason": "progressive planner admitted fragment issue-108-testbudget-full",
  "exactMutationSha256": "80502791098496e02d6f2bb71df0c93c277952314dcd8305279001a1bc922b35",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "testBudget story contract and planner/replan gates (issue S3)",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A6",
          "G-A7",
          "G-A8",
          "G-C4",
          "G-C5",
          "G-C6",
          "G-C7"
        ]
      },
      {
        "id": "S2",
        "title": "Negotiated declared-test admission, watchdog sizing and budget evidence (issue S4)",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A8",
          "G-C3",
          "G-C6",
          "G-C7",
          {
            "omittedItems": 1
          }
        ]
      },
      {
        "id": "S3",
        "title": "Cross-story contract checks, verification gate and PR for #108",
        "dependsOn": [
          "S1",
          "S2"
        ],
        "goalInvariantIds": [
          "G-A7",
          "G-A8",
          "G-A9",
          "G-A10",
          "G-C1",
          "G-C2",
          "G-C3",
          "G-C8",
          {
            "omittedItems": 3
          }
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
