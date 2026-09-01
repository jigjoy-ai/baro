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
  "proposalId": "run-progressive-ca5d70d8c7805d67:planner:6214b643f294d02b474f05a856e3d64e71c42bf31f29c3ca65f92d77b9b8b8e7",
  "sourceStoryId": "planner:planning-ca5d70d8c7805d67-1",
  "reason": "progressive planner admitted fragment issue-112-invariant-coverage-prefix",
  "exactMutationSha256": "bba8999637805607901e154887f9c98e2f6dfc1f33f460549e2bfce11b69e5c1",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Repair prompt lists unowned goal invariants with canonical statements",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A3",
          "G-A6",
          "G-C2"
        ]
      },
      {
        "id": "S2",
        "title": "Pass unowned invariants with text at the single finalization repair call site",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A5",
          "G-A6",
          "G-C2"
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
  "proposalId": "run-progressive-ca5d70d8c7805d67:planner:65d5c1a35aa1876c55b775614dd01cbd48cd003087ee0da93992f7377df00daf",
  "sourceStoryId": "planner:planning-ca5d70d8c7805d67-1",
  "reason": "progressive planner admitted fragment final-60860158243c096515c5c8dd5e7b4f67d2f902652fed0552a43fdfe7d5f1534b",
  "exactMutationSha256": "85b17e91c4ad44cf5d3abfcb1acaa6f401609fe50d2e2152f71a43a3f33948a1",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S3",
        "title": "Conformance test: claude-lane receipt, repair prompt invariants, notice-before-terminal ordering",
        "dependsOn": [
          "S1",
          "S2"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A6",
          "G-A7",
          "G-A8",
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
