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
  "proposalId": "run-progressive-6701db1e0f93fc45:planner:a9305f00c7aeaac74adaa295c856ddb72c51d25a43d56b68faefbe513acc43bf",
  "sourceStoryId": "planner:planning-6701db1e0f93fc45-1",
  "reason": "progressive planner admitted fragment final-tail-1",
  "exactMutationSha256": "f0368330dd59e0984e3e47c3a2ee8a40cbb4247d590286bef591a520e5a8fe84",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "#159: Fast-forward the host checkout only after verification passes",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1"
        ]
      },
      {
        "id": "S2",
        "title": "#136: Build the branch slug from the Objective line",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A3"
        ]
      },
      {
        "id": "S3",
        "title": "#144a: Block publish commands in every story lane and emit StoryCommandRefused",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A4",
          "G-C6"
        ]
      },
      {
        "id": "S4",
        "title": "#148: Run an npm-wrapped node --test script directly as one deduplicated invocation",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A6"
        ]
      },
      {
        "id": "S5",
        "title": "#161: Release a story's write-surface ownership when it integrates, using one shared overlap rule",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A10",
          "G-C4"
        ]
      },
      {
        "id": "S6",
        "title": "#119: Sync the subprocess descendant test on a pid file instead of a delay",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A9"
        ]
      },
      {
        "id": "S7",
        "title": "#140: Keep run state under ~/.baro/runs/<id>/ and offer discard or fresh start when the saved branch is gone",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A2",
          "G-C3"
        ]
      },
      {
        "id": "S8",
        "title": "#144b: Reject delivery obligations at admission and remove delivery from the operator prompt",
        "dependsOn": [
          "S3"
        ],
        "goalInvariantIds": [
          "G-A4",
          "G-C2"
        ]
      },
      {
        "omittedItems": 5
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
  "proposalId": "replan-2e9c742d-738a-418b-96d7-deb46471615b",
  "sourceStoryId": "S12",
  "reason": "S12 (#163) acceptance O-030 requires storyTimeoutSecs to return undefined when unset and makes explicit timeoutSecs a wall bound; two existing tests outside S12's write surface pin the old semantics and fail. Follow-up test-only story keeps G-C5 green.",
  "exactMutationSha256": "29a34e88fc8d68513c79575612a4d03309e9a38542b40927a8624b5f451ccc31",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S12-tests",
        "title": "#163 follow-up: update two existing tests that pin the pre-#163 story timeout semantics",
        "dependsOn": [
          "S12"
        ],
        "goalInvariantIds": [
          "G-C5",
          "G-A12"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
