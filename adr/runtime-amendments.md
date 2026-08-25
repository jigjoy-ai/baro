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
  "proposalId": "run-progressive-d0828e29729ff92b:planner:3ff660f7b663e5c511427c6e16678860072c6a5cfecb98d69a7f0e2a8e1459a3",
  "sourceStoryId": "planner:planning-d0828e29729ff92b-1",
  "reason": "progressive planner admitted fragment baro-reliability-gaps-2",
  "exactMutationSha256": "9deda988aa2cc677934255726951a25e5a0f376de37fa92e9a9ef9ffc904f473",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Patient dialogue retry policy",
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
            "omittedItems": 6
          }
        ]
      },
      {
        "id": "S2",
        "title": "Shell no-progress counter in the supervisor",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A6",
          "G-A7",
          "G-A8",
          "G-A9",
          "G-A10",
          "G-C5",
          "G-C6",
          "G-C7",
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
