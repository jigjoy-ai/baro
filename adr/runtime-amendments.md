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
  "proposalId": "run-progressive-4527f5e77bc20c39:planner:ced709a966598a1d6239d88c1fc8e4665cb267bb08bbf5e38a0d87609555ad8d",
  "sourceStoryId": "planner:planning-4527f5e77bc20c39-1",
  "reason": "progressive planner admitted fragment issue-137-integration-worktree-all",
  "exactMutationSha256": "9e45d43f0079f6f753f998e3effeee222cdd2f42cecc9f432d0dbd842e5db317",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "IntegrationWorktree module, git.ts helpers, WorktreeManager integrationRoot split",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A2",
          "G-C5"
        ]
      },
      {
        "id": "S2",
        "title": "GitCoordinator and Finalizer take repoRoot/integrationRoot",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-C4",
          "G-C5"
        ]
      },
      {
        "id": "S3",
        "title": "Integration tests for IntegrationWorktree with real temp repos",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A3",
          "G-C5"
        ]
      },
      {
        "id": "S4",
        "title": "Wire repoRoot/integrationRoot, host sync and cleanup into orchestrate.ts",
        "dependsOn": [
          "S1",
          "S2",
          "S3"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-C1",
          "G-C2",
          "G-C3",
          "G-C4",
          "G-C5"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```

## Graph version 3

```json
{
  "graphVersion": 3,
  "proposalId": "replan-f9f4d256-3e21-47fd-a716-6343fd46d097",
  "sourceStoryId": "S4",
  "reason": "S4 wiring leaves the user checkout on its base branch per goal; the only stale assertion of the old checkout switch is test/collective-orchestrate.test.ts:2521, owned by no story. G-A1 needs it updated.",
  "exactMutationSha256": "31f62752ae797eea2326d68aafbe341a1be84b2f483f00bbcacfbaf838571941",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S5",
        "title": "Update collective-orchestrate local-only test for isolated integration worktree",
        "dependsOn": [
          "S4"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-A2"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
