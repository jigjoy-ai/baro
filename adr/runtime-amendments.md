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
  "proposalId": "run-progressive-5454d438780869ea:planner:27a8bd5a778dac6bf9e156380fff0784c6c6812f4c21099d4772ffadf7762a87",
  "sourceStoryId": "planner:planning-5454d438780869ea-1",
  "reason": "progressive planner admitted fragment goal-constraint-canonicalization-prefix-2",
  "exactMutationSha256": "059193cff90c7e10219dcd25707398574d55d3526543d1ec2c0ee2830fca4351",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Canonicalize and fully aggregate constraint-predicate defects in goal-constraint-appendix.ts",
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
            "omittedItems": 4
          }
        ]
      },
      {
        "id": "S3",
        "title": "Record the predicate-matching rule in a new ADR",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-C6",
          "G-C7"
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
  "proposalId": "run-progressive-5454d438780869ea:planner:cde06fc20317d2c72a65c9a5012a92d6d480455e127c7d2e44a5dc4455dfcc94",
  "sourceStoryId": "planner:planning-5454d438780869ea-1",
  "reason": "progressive planner admitted fragment final-53d7ed239d777b3e5672c6a1cce5b37637b99a9f933a407b126f005f7c5efcba",
  "exactMutationSha256": "67c3ced7886880917686a730b28688cd83f02b9247cbba8a3ab39e4da94381ff",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S2",
        "title": "Thread canonicalConstraintPredicates through the outcome gate and wire it in run-architect",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A5",
          "G-C2",
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
