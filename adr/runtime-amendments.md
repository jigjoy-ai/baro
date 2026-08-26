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
  "proposalId": "run-progressive-242ee10fe8071c3f:planner:7796a8c5b73cc56fb259b15783e286a7017154db6b926277137403eb8ea2827b",
  "sourceStoryId": "planner:planning-242ee10fe8071c3f-1",
  "reason": "progressive planner admitted fragment final-5de9d18db934b9757d4d3e20107a86400953b9e906abdf1dd3868aed7ff705d8",
  "exactMutationSha256": "fa8a0446c940c17436390a06856ae0a04f412f2483ee669cb104506c2075b720",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "S1",
        "title": "Wire altitude advisory section and warn activity into critic-evidence",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-A1",
          "G-A2",
          "G-A3",
          "G-A4",
          "G-A5",
          "G-A6",
          "G-A7",
          "G-C1",
          {
            "omittedItems": 8
          }
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
  "proposalId": "goal-remediation-fa07730e59a6a2285f9b43ab",
  "sourceStoryId": "goal:challenge-0999c98b-9bb1-48df-900b-6acf3a2422ac",
  "reason": "autonomous remediation for G-C1: G-C1 keeps src/acceptance/altitude-probe.ts read-only, but honoring it makes G-A1/G-A4 unsatisfiable without regressing an existing security guarantee. collectAltitudeFindings runs git through runRepositoryCommand with no hardening args, unlike critic-evidence's runGit which passes -c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= plus GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1, GIT_OPTIONAL_LOCKS=0. Measured: temp repo with core.fsmonitor=<script writing a sentinel>; sentinel absent before collectAltitudeFindings({cwd,baseSha,timeoutMs:10000}), present after. Wiring the probe into prepareCriticEvaluation therefore (a) breaks the pre-existing assertion test/acceptance/critic-evidence.test.ts:189 'Critic git evidence must disable repository-configured fsmonitor helpers' (the Critic would execute agent/repo-controlled hook programs in a story worktree) and (b) makes the hook write a file between the before/after changed-content fingerprints, flipping preparation.status to 'inconclusive' so the Critic never evaluates at all; the existing test 'feeds the same real diff/status and command evidence to every tool-less backend' fails with captured=[]. AltitudeProbeOptions exposes only {cwd, baseSha, timeoutMs}, so no caller-side hardening is possible from critic-evidence.ts, and O-019 forbids re-deriving findings with critic-evidence's own hardened runGit. Corrective work needed: harden the git invocations inside altitude-probe.ts (the module that already declares itself the sole I/O owner) — a ~5-line change in a file G-C1 forbids me to touch.",
  "exactMutationSha256": "d25df91711e5f6d2c25e63386ff37841faa5f200d7f822d051f3ab5f1cda9f97",
  "mutationSummary": {
    "addedStories": [
      {
        "id": "GREM-fa07730e59a6",
        "title": "Resolve goal challenge G-C1",
        "dependsOn": [],
        "goalInvariantIds": [
          "G-C1"
        ]
      }
    ],
    "removedStoryIds": [],
    "modifiedDeps": {}
  }
}
```
