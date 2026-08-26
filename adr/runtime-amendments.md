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
  "proposalId": "run-progressive-d0000f86e03edf70:planner:6121f25d66b5e8be6aa9ba88efa5a69a58c2098f527c2de278e0286ed1621007",
  "sourceStoryId": "planner:planning-d0000f86e03edf70-1",
  "reason": "progressive planner admitted fragment baro-cli-launch-resume-prefix-1",
  "exactMutationSha256": "4b78d22ec7ac6d8b0c7697403420f5d2a8d2036f3718a9be2f684220d538e177",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Rust CLI flags: --goal-file, --detach, --shell-budget, help text",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A5",
          "G-A12",
          "G-C1",
          "G-C5",
          "G-C9",
          "G-C14"
        ]
      },
      {
        "id": "S2",
        "title": "Run registry: log paths, register_detached, watch/logs commands",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A2",
          "G-A3",
          "G-C2",
          "G-C3",
          "G-C11"
        ]
      },
      {
        "id": "S3",
        "title": "New cli/launch.rs: pure detach plan, goal fingerprint, bare-launch decision",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A2",
          "G-A9",
          "G-C2",
          "G-C9",
          "G-C12",
          "G-C13",
          "G-C17"
        ]
      },
      {
        "id": "S4",
        "title": "Rust PRD schema: round-trip goalFingerprint, mergeStatus, mergeCommitSha",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A6",
          "G-C6"
        ]
      },
      {
        "id": "S7",
        "title": "TS translator: accept workspace selector between \u0060run\u0060 and the script name",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A10",
          "G-C10",
          "G-C13"
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
  "proposalId": "run-progressive-d0000f86e03edf70:planner:1b83a519b93e745ea9b98fb7990bf3b760cea9360dab5c918d15c2fec027a0db",
  "sourceStoryId": "planner:planning-d0000f86e03edf70-1",
  "reason": "progressive planner admitted fragment final-cabeccab76e492751b4f844647d2f6e6fe83d3f653d9a545e8de48b4c9977691",
  "exactMutationSha256": "08b4afb27efeaa99fa9b2a52124c9b7f408a2158f18f789ab3245667c0ceacd7",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S5",
        "title": "Rust wiring: detach spawn, BARO_RUN_ID scrub, watch/logs dispatch, shell budget, resume/continue/fingerprint",
        "dependsOn": [
          "S1",
          "S2",
          "S3",
          "S4"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-A4",
          "G-A5",
          "G-A7",
          "G-A8",
          "G-A9",
          "G-A11",
          "G-C2",
          {
            "omittedItems": 9
          }
        ]
      },
      {
        "id": "S6",
        "title": "TS: mid-run prd.json status writer, merge commit sha, and --resume story selection",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A6",
          "G-A7",
          "G-A11",
          "G-C6",
          "G-C7",
          "G-C13",
          "G-C16",
          "G-C17"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```

## Graph version 4

```json
{
  "graphVersion": 4,
  "proposalId": "run-progressive-d0000f86e03edf70:discovery:1:S4:S8",
  "sourceStoryId": "S4",
  "reason": "cargo build -p baro-tui fails with E0063 missing field goal_fingerprint at progressive_planning.rs:290 once PrdFile.goal_fingerprint is added per ADR-011; conversation_host.rs:503 has the same construction pattern in an inline test. Neither file is owned by any of the 7 declared stories, so S4 cannot fix this within its own write surface (executor.rs only).",
  "exactMutationSha256": "70a4e79c49caa93fd1717170fb072ac02e8225b516105c098e4ae93d49f388c0",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S8",
        "title": "rust-prd-schema-satellite-sites",
        "dependsOn": [
          "S4"
        ],
        "goalInvariantIds": [
          "G-A6"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```

## Graph version 5

```json
{
  "graphVersion": 5,
  "proposalId": "goal-remediation-c908e86915ca9043c79df06e",
  "sourceStoryId": "goal:challenge-4c91f851-e1ad-45b8-8965-0d91cde46dd0",
  "reason": "autonomous remediation for G-A6: S4 (executor.rs only) cannot produce fresh-passing evidence for O-016/O-046 in isolation: crates/baro-tui is a single-binary crate (one [[bin]] target, no lib split), so cargo test -p baro-tui executor::tests recompiles the whole crate. Adding PrdFile.goal_fingerprint per ADR-011 (mandated for this story) breaks two unowned struct-literal sites (progressive_planning.rs:290, conversation_host.rs:503) that are not in any of the 7 declared writes arrays. I already disputed the ADR-001 completeness claim and filed discovered story S8 (writes exactly those two files, depends on S4) to carry the trivial one-line fix. I then tried to block S4 on S8, which the broker correctly rejected as a dependency_cycle: S8 cannot be authored/compiled before S4's field exists, yet S4 cannot get fresh green evidence before S8's fix exists. This is a structural ordering deadlock between per-story isolated-worktree fresh-evidence requirements and a monolithic single-binary compile unit, not a defect in my own diff (verified separately: I temporarily patched both external sites locally, ran cargo test -p baro-tui executor::tests, all 9 tests including the 2 new ones passed, then reverted those two files so only executor.rs is committed). Need governance to either (a) admit S4+S8 as one atomically-merged unit, (b) widen S4's write surface by two lines each in those files, or (c) accept ADR-013's run-level (post-integration) gate as the place this specific criterion is actually evidenced, since isolated per-story compilation cannot satisfy it for any additive PrdFile field.",
  "exactMutationSha256": "709d7d894c76030ef6ea781984bf4c391e253680edf98c828fe9af17bef742d0",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "GREM-c908e86915ca",
        "title": "Resolve goal challenge G-A6",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A6"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```

## Graph version 6

```json
{
  "graphVersion": 6,
  "proposalId": "run-progressive-d0000f86e03edf70:dependency-block:block-4abfd048-9668-45d3-a3ae-21189900c238",
  "sourceStoryId": "S4",
  "reason": "S4's own perimeter test (cargo test -p baro-tui executor::tests) cannot compile in isolation: adding goalFingerprint/mergeStatus/mergeCommitSha to PrdFile/PrdStory in executor.rs (S4's only write surface) breaks two full-struct-literal PrdFile constructors this story does not own (progressive_planning.rs:290, conversation_host.rs:503), producing E0063. GREM-c908e86915ca already fixed this exact coupling on commit a60558c (PrdFile derives Default, both satellite sites use ..Default::default()), verified there to compile and pass 23 tests including S4's own O-016/O-046 evidence, but a60558c is not yet an ancestor of this worktree. S4 cannot honestly turn its perimeter green without either touching files outside its declared write surface (executor.rs only) or waiting for GREM-c908e86915ca to land. Requesting GREM-c908e86915ca as a hard prerequisite so this worktree can resume once the Default-derive fix is integrated.",
  "exactMutationSha256": "82cbf3d47d8447e719ea8e8222ad99d522db94605f0765fdd8fb1e2f8145a6b5",
  "mutationSummary": {
    "addedStories": [],
    "removedStoryIds": [],
    "modifiedDeps": {
      "S4": [
        "GREM-c908e86915ca"
      ]
    }
  }
}
```
