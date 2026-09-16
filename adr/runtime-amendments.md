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
  "proposalId": "run-progressive-1154bc86578a6a8b:planner:f9fb99c384dd790e8c7613f1696673ab5c137025698a67df39d10ca08508adbd",
  "sourceStoryId": "planner:planning-1154bc86578a6a8b-1",
  "reason": "progressive planner admitted fragment issue-153-all",
  "exactMutationSha256": "76cdb29872c63f0da789b93b11d035af20cf2d5d90b091f420888468abcc87e5",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Rust: create goal branch without checkout; narrow branch guards, resume, rerun, follow-up",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-C1",
          "G-C3",
          "G-C4"
        ]
      },
      {
        "id": "S2",
        "title": "Orchestrator: always build IntegrationWorktree on plain runs; update worktree integration tests",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-C2"
        ]
      },
      {
        "id": "S3",
        "title": "Regression test: real orchestrate() run leaves host checkout untouched",
        "dependsOn": [
          "S2"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-A3",
          "G-C2",
          "G-C5"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
