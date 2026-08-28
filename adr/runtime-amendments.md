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
  "proposalId": "run-progressive-6e2705e4e9fe7fb1:planner:9700948eb33c870aefcb17ef6adb5709050c9bd66067ec56e16bd3d8c5e52c9c",
  "sourceStoryId": "planner:planning-6e2705e4e9fe7fb1-1",
  "reason": "progressive planner admitted fragment final-a3c4f989774b353f2d0a2da02964adb8892a44752cbdf0231a2038c213d57c93",
  "exactMutationSha256": "8ca2a8a5a79ae3980208b9d7d5177e19778a74a5ba6273a1c304ecbdcc486df3",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Outcome-driven final-tail admission with redundant-tail tolerance",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A6",
          "G-A7",
          "G-C1",
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
