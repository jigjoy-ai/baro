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
  "proposalId": "run-progressive-db4b83724cf3e080:planner:3a35f7a0866e7f005d263a5c08261ca256e10cd37685cad7643ed5dd93ba1b94",
  "sourceStoryId": "planner:planning-db4b83724cf3e080-1",
  "reason": "progressive planner admitted fragment awake-clock-foundation-1",
  "exactMutationSha256": "3104b4b6c1898013fcef9f6a9c761474d63f6edf016959907f03ff080185ca37",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Awake clock primitive + fake + re-arming deadline handle",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-C1",
          "G-C3",
          "G-C5",
          "G-C6",
          "G-C7"
        ]
      },
      {
        "id": "S2",
        "title": "suspension_gap_absorbed event + single gap-reporter bridge",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A5",
          "G-A7"
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
  "proposalId": "run-progressive-db4b83724cf3e080:planner:4b6ea8870f0abcccf00c848acdd2772371e8cc15f081f4f2756fdb81a82ae855",
  "sourceStoryId": "planner:planning-db4b83724cf3e080-1",
  "reason": "progressive planner admitted fragment final-tail-2",
  "exactMutationSha256": "5dfa12ed9b9d4edeed5bbe3bd0ebd25198957adcb2fbb3440d78c6726c15285b",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S3",
        "title": "Adopt awake clock in the architect phase/obligations budgets",
        "dependsOn": [
          "S1",
          "S2"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-A4",
          "G-A7",
          "G-C2",
          "G-C3",
          "G-C7"
        ]
      },
      {
        "id": "S4",
        "title": "Adopt awake clock for board and conductor soft deadlines",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-A4"
        ]
      },
      {
        "id": "S5",
        "title": "Adopt awake clock in the verification gate and goal-review deadline",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-A3"
        ]
      },
      {
        "id": "S6",
        "title": "Adopt awake clock in harness idle/absolute timeouts and CPU-activity windows",
        "dependsOn": [
          "S1"
        ],
        "goalInvariantIds": [
          "G-A2",
          "G-A3",
          "G-A4",
          "G-C1",
          "G-C7"
        ]
      },
      {
        "id": "S7",
        "title": "Rust awake clock in baro-tui: Tick sampling and consistent awake elapsed",
        "dependsOn": [
          "S1",
          "S2"
        ],
        "goalInvariantIds": [
          "G-A4",
          "G-A6",
          "G-C4",
          "G-C5"
        ]
      },
      {
        "id": "S8",
        "title": "Cross-cutting awake-clock adoption conformance spec",
        "dependsOn": [
          "S1",
          "S2",
          "S3",
          "S4",
          "S5",
          "S6"
        ],
        "goalInvariantIds": [
          "G-A3",
          "G-A4",
          "G-A5",
          "G-C3",
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

## Graph version 4

```json
{
  "graphVersion": 4,
  "proposalId": "goal-remediation-417050fb4ea14da64a101344",
  "sourceStoryId": "goal:challenge-542a958f-ee6f-4bc9-940b-80d1761c9b10",
  "reason": "autonomous remediation for G-A7: No adopter registers its AwakeDeadline with the attribution seam, so the emitted gap line can never name the affected budget -- and worse, actively misreports it.\n\nEVIDENCE (three independent agents, all consistent):\n- S2 (owner of src/runtime/awake-clock-log.ts and the G-A7 evidence): 'awake-clock.ts has no armed-budget registry ... attribution needs a seam: trackAwakeBudget(deadline). With nothing registered every gap reports budget: \"*\". Adopters (S3-S6) are welcome to call it -- until someone does, production gap lines are unattributed.' S2 closed with: 'Someone owning G-A7 should decide whether adopters must register.'\n- S4 (me, committed 6786fd4): did NOT call trackAwakeBudget for 'board-soft-deadline'. awake-clock-log.ts does not even exist in the S4 worktree (ls: No such file or directory), and attribution is not in S4's description or criteria (S4 owns G-A2/G-A4).\n- S5: 'I did NOT call trackAwakeBudget() for verification-gate/goal-completion-gate/goal-review -- out of this story scope/criteria. If no adopter registers, every production gap line reports budget: \"*\".'\n\nWHY THIS CONTRADICTS G-A7 RATHER THAN MERELY WEAKENING IT: ADR-004 defines budget:'*' as the value emitted 'when the gap is detected outside any armed budget'. With zero registrations, a gap absorbed WHILE the board soft deadline (or the verification gate, or the architect phase budget) is armed still emits '*' -- i.e. the one line G-A7 requires asserts that no budget was affected, which is false. G-A7 demands the line name 'trajanjem gap-a I POGODJENIM BUDZETOM'; gap_ms is correct, budget is structurally unobtainable in production.\n\nWHY NO EXISTING STORY CLOSES IT: the seam lives in S2's file but the calls must land in the adopter files, which belong to S3/S4/S5/S6. S4 is committed and immutable; S5 and S2 have both explicitly declined as out-of-scope. No story in DAG version 3 is chartered to make an adopter register.\n\nMISS… [truncated sha256:fd9a4774dbc0d92c]",
  "exactMutationSha256": "a86848e300e653522ea857441f1fd9d90169d77cb93e88467a73c056b378c605",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "GREM-417050fb4ea1",
        "title": "Resolve goal challenge G-A7",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A7"
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
  "proposalId": "replan-2521b1c7-5e5e-4202-95a1-39e7bc401c83",
  "sourceStoryId": "S2",
  "reason": "G-A7 (owned by S2) requires the absorbed-gap line to name the affected budget. S2 shipped the bridge plus a trackAwakeBudget attribution seam, but the adopted budgets live in files S2 does not own, and S4, S5 and S6 each reported that registering was outside their criteria, so every production gap line currently reports budget: '*' -- duration named, budget never. One follow-up story after the adopters integrate closes that gap without reopening an active story.",
  "exactMutationSha256": "3b4024c3978b2ee4e8d5b022fd0546e911bd7af08e0997222b592291aa55f265",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S9",
        "title": "Register adopted awake deadlines so a gap line names the budget it hit",
        "dependsOn": [
          "S3",
          "S4",
          "S5",
          "S6"
        ],
        "goalInvariantIds": [
          "G-A7"
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
  "proposalId": "run-progressive-db4b83724cf3e080:dependency-block:block-a182b2b7-b3e2-4fb1-976d-cec47776521f",
  "sourceStoryId": "GREM-417050fb4ea1",
  "reason": "GREM must edit two files that do not exist in its worktree, and inventing them would collide with S2 at merge. This worktree is based on 270e69a (the S1 merge). Verified absences: 'ls packages/baro-orchestrator/src/runtime/awake-clock-log.ts' -> No such file or directory; 'grep -rn trackAwakeBudget packages/' -> no hits; 'grep -rn suspension_gap_absorbed packages/' -> no hits; 'grep -rn createAwakeDeadline packages/' -> zero call sites outside runtime/awake-clock.ts itself. The two files GREM must change to make a gap line name its budget are src/runtime/awake-clock-log.ts (affectedBudget must read the clock's armed-budget registry) and, for the event member it asserts against, src/tui-protocol.ts. Both land only in S2's branch (9643882). Writing them here means recreating S2's bridge from scratch and taking an add/add conflict on the exact file whose contents are the point of the story -- precisely the temporary/stale code the block path exists for. Only S2 is required, not S2..S6: the fix registers each AwakeDeadline inside createAwakeDeadline (clock-local closure state in awake-clock.ts, no new imports, agreed in writing with S2 who owns the bridge), so no adopter file is touched at all and S3/S4/S5/S6 are not prerequisites -- board-soft-deadline, verification-gate, goal-completion-gate, goal-review, architect-* and harness-liveness all become attributed automatically when their branches merge. Regression evidence constructs createAwakeDeadline({budget:'board-soft-deadline'}) directly against a fake clock, so it needs no adopter branch either. S2 has confirmed it is not touching any adopter file and that its own follow-up story S9 stands down in favour of GREM; my replan to delete S9 was rejected (destructive_removal), so the block is the remaining way to sequence this correctly. On resume against a tree containing S2, GREM can discharge G-A7 end to end in one session.",
  "exactMutationSha256": "96c4f975711abe5e92f0f330b39ea11691ec1bd2b345f8cb5fc842633cad5412",
  "mutationSummary": {
    "addedStories": [],
    "removedStoryIds": [],
    "modifiedDeps": {
      "GREM-417050fb4ea1": [
        "S2"
      ]
    }
  }
}
```

## Graph version 7

```json
{
  "graphVersion": 7,
  "proposalId": "replan-99c32de3-21cb-4644-9b34-27eb305c1754",
  "sourceStoryId": "S2",
  "reason": "The authoritative review required S2 to add the ADR-004 ignoring fallback variant to crates/baro-tui/src/events.rs even though it breaks cargo build in isolation. It does: error[E0004] at app.rs:1527, App::handle_event has no wildcard arm. app.rs is S7's surface and ADR-009 scopes it comment-only, so no story is currently obliged to add the one arm the crate now needs, and G-A5 (clean build on both stacks) fails for the whole merged tree until someone does. S2 asked S7 directly; this story is the insurance that the arm exists even if S7 does not act, and is a no-op if S7 does.",
  "exactMutationSha256": "f8a23a99e79a530adadf86e58c51d3e7ef314a3cf1fe136976bd49bfcb120091",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S10",
        "title": "Guarantee crates/baro-tui compiles with the BaroEvent::Unrendered fallback",
        "dependsOn": [
          "S7"
        ],
        "goalInvariantIds": [
          "G-A5"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```

## Graph version 8

```json
{
  "graphVersion": 8,
  "proposalId": "replan-881a0177-c111-4535-a1f8-b257791f2f92",
  "sourceStoryId": "S2",
  "reason": "ADR-004's ignoring fallback cannot be delivered by any story that owns only events.rs: the variant it prescribes makes App::handle_event non-exhaustive (E0004 at app.rs:1527), S2 cannot write app.rs, and a block on S7 was rejected as a dependency cycle. S2 reverted its attempt to keep cargo build clean and is otherwise green. This story owns events.rs AND app.rs together -- the only surface on which the variant, its match arm and its test compile in one commit. It depends on S7 and S10 so it cannot interleave with either.",
  "exactMutationSha256": "bcf6be91f16254199328e2c2e6cf3dfa66ea9f0ad3674fc4225464288bc72c6a",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S11",
        "title": "Land ADR-004's ignoring fallback atomically across events.rs and app.rs",
        "dependsOn": [
          "S7",
          "S10"
        ],
        "goalInvariantIds": [
          "G-A5"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
