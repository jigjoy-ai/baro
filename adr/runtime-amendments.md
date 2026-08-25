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
  "proposalId": "run-progressive-ed461d491e308c56:planner:ce390be07765cf3921635cd81f17c5ec03beab720bbca9653e72f0b2c870b374",
  "sourceStoryId": "planner:planning-ed461d491e308c56-1",
  "reason": "progressive planner admitted fragment baro-three-correctness-fixes-1",
  "exactMutationSha256": "bb5b032ae9df955333d547006887c0280d1ef7e5c5e57024b07e4eb4565a72c0",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Replan admission: reject overlapping write surfaces",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A4",
          "G-C1",
          "G-C3",
          "G-C4",
          "G-C6"
        ]
      },
      {
        "id": "S2",
        "title": "Re-announce write-surface gate at StorySpawned when the key changed",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A2",
          "G-A4",
          "G-C2",
          "G-C3",
          "G-C6"
        ]
      },
      {
        "id": "S3",
        "title": "Containment guard: exempt sed/awk script operands",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A3",
          "G-A4",
          "G-C2",
          "G-C3",
          "G-C5",
          "G-C6"
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
  "proposalId": "goal-remediation-2f4b0c88aef638c4a04d18cd",
  "sourceStoryId": "goal:challenge-29cfcf2a-b345-4d06-af68-3f50acc1c365",
  "reason": "autonomous remediation for G-A4: O-011 (S1 criterion 12) currently has NO owner able to supply its evidence, and the authoritative review is charging it to S1, which blocks S1 from ever completing green although every other criterion passes. Repository evidence, re-checked this pass: 'git branch -a --list *run-progressive-ed461d491e308c56*' returns only S1 d79a88a and S2 08ad429 -- S2's branch still sits at the BASE commit with no story commit, and no S3 branch or worktree exists. grep in my tree: StorySpawned in src/execution/collective-board.ts = 0, isSedAwkScriptOperand in src/planning/adapters/codebase-tools.ts = 0. The merged tree O-011 demands is therefore not merely unreachable from S1, it has not been produced by anyone: two of its three inputs do not exist yet. No story can close this: (a) S2's and S3's files are outside every other story's declared write surface, so merging them into a story worktree is refused at the integration gate; (b) the goal's own Non-goals forbid exactly what criterion 12 asks a story to do -- 'Ponovno pokretanje ili prebrojavanje repo-wide test suite-a od strane pojedinačnih story-ja'; (c) G-C2 states repo-wide test commands are refused by the shell, and my VERIFICATION SCOPE states the host proves the fully-merged tree once, after integration; (d) O-011's own scenario says the gate 'executes once, after story-level perimeters already passed' and ADR-007 says run-level verification 'happens once, outside the stories'. So G-A4 is endangered not because the work is wrong but because its verification is unowned: the run-level gate that is supposed to discharge it is not demonstrably present in this run, and story-level review keeps demanding it from a story that is structurally and contractually barred from producing it. Corrective work needed from governance: either (1) confirm O-011 is discharged by the host's post-integration run-level gate and detach it from S1's story-level acceptance criteri… [truncated sha256:fc3a91f35385416d]",
  "exactMutationSha256": "2e818a2eb6a066d96bfab37b69982e01b80675ac823a6fcee0f848c801ceaf80",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "GREM-2f4b0c88aef6",
        "title": "Resolve goal challenge G-A4",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A4"
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
  "proposalId": "goal-remediation-ec668e7ef8e12854bf3638a3",
  "sourceStoryId": "goal:challenge-551bb584-0493-45f0-9fc5-2f85c2ea7691",
  "reason": "autonomous remediation for G-A4: PASS-2 REJECTION OF S1 ON O-011 (criterion 12), with NEW evidence that BOTH remedies named in the prior G-A4 resolution are now closed. This is not a restatement of challenge-29cfcf2a; that one was resolved by remedy (1) and I am reporting that remedy (1) provably did not take effect and remedy (2) is rejected by this repository's own code.\n\nWHAT IS NEW SINCE THE PRIOR RESOLUTION:\n(a) Remedy (1) IS merged and wired, and the Critic still charged O-011 to S1 anyway. src/acceptance/critic-evidence.ts:999-1006 emits the '## Verification scope' section whose text says 'never fail a criterion because this story did not run the repository full suites, did not merge or await another story, or produced no whole-merged-tree result'; src/orchestrate.ts:1064 sets hostRunsWholeTreeVerification: coordinationMode === 'collective'. Both are present at my HEAD (773771f, base 4ccdd53 which contains d102e2b). The pass-2 review nonetheless failed criterion 12 for exactly the three reasons that section forbids. So the judge deciding this run is not applying the merged fix.\n(b) Remedy (2) -- 'create an integration-verification story that runs after S1+S2+S3 merge and owns O-011 evidence' -- is IMPOSSIBLE by code, not by preference. src/runtime/runtime-replan.ts:287-292 rejects any added story for which isVerificationOnlyStory() is true with invalid_proposal: \"added story '<id>' is verification-only; final test/build/lint gates belong to RunVerifier\". src/planning/domain/verification-stories.ts:1-11 states the policy outright: 'Deterministic final gates belong to RunVerifier, after every implementation commit has been integrated.' Any replan I submit to create O-011's owner would be refused by the very validator this story implements.\n(c) The documented escape hatch does not exist in this build. My launch prompt documents 'emit --kind dispute --claim --command --output [--obligation O-011]' to withdraw an impossible lit… [truncated sha256:ad69cad9beaa7151]",
  "exactMutationSha256": "ab486f7190b6c59ae9008c4386f88aae9bbb69b92f97f80a7cbbdacc77b86f21",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "GREM-ec668e7ef8e1",
        "title": "Resolve goal challenge G-A4",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A4"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
