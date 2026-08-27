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
  "proposalId": "run-progressive-838df76581beeb2e:planner:6b6e02e6e8dabb0ab1fbfd3703083dc33abc8597053d7da65987a46f75038f81",
  "sourceStoryId": "planner:planning-838df76581beeb2e-1",
  "reason": "progressive planner admitted fragment suspension-resume-completion-1",
  "exactMutationSha256": "d76ecfb76a2abd0763e521d59a41129d0ddf9a679c975faafb77ddad4f490e1c",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "integration_refused semantic event emitted at GitCoordinator refusal sites",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A5",
          "G-A6",
          "G-C2",
          "G-C3",
          "G-C4",
          "G-C5",
          {
            "omittedItems": 4
          }
        ]
      },
      {
        "id": "S2",
        "title": "Route the post-suspension spawn path through host-owned resumeFromSuspension",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A6",
          "G-C1",
          "G-C2",
          "G-C4",
          "G-C5",
          {
            "omittedItems": 4
          }
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
