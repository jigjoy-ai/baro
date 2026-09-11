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
  "proposalId": "run-progressive-ec6f6a6771ef44fa:planner:77a4c9e339fbeea1a97cc5c34de2749a33e520c9e801dd50c35b420061ccb53c",
  "sourceStoryId": "planner:planning-ec6f6a6771ef44fa-1",
  "reason": "progressive planner admitted fragment issue-108-testbudget-full",
  "exactMutationSha256": "12737108fb08779d888b1c7c95040d72584adc4d2cd2f22c7d0dd1e494ae4f63",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Import-free declared-test budget leaf module and constant relocation",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A5",
          "G-C1",
          "G-C2",
          "G-C4",
          "G-C5",
          "G-C6",
          "G-C9"
        ]
      },
      {
        "id": "S2",
        "title": "Preserve testBudget through the Rust PRD round-trip",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1"
        ]
      },
      {
        "id": "S3",
        "title": "testBudget in the PrdStory contract and every TypeScript planner/replan gate",
        "dependsOn": [
          "S1",
          "S2"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-C5"
        ]
      },
      {
        "id": "S4",
        "title": "Negotiated budget admission in createVerifyPlan, merge/timeout scaling, raw reader and call-site evidence",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A6",
          "G-A7",
          "G-A8",
          "G-A9",
          {
            "omittedItems": 11
          }
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
