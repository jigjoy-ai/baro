# ADR-0004: Add an `origin` discriminator to VerifyCommandSpec so declared story tests are identifiable

**Status:** Accepted
**Context:** The retry must apply to run-level commands only, but translated declared story tests are today indistinguishable from detected ones once inside `plan.commands` (declared-verification.ts sets `declaredRequirementKey` only on never-executed specs). Matching on labels (`isTestCommandLabel`) cannot express provenance.
**Decision:** In `packages/baro-orchestrator/src/verification/verify.ts`:
- Add to `VerifyCommandSpec` (near verify.ts:81): `readonly origin?: "detected" | "declared";` — absent means `"detected"`.
- `boundedDeclaredCommands` (verify.ts:611-644) is the SINGLE owner of the stamp: every spec it appends (including the overflow stub at verify.ts:685 and any `incomplete()` spec) is spread into `{ ...spec, origin: "declared" }`. `declared-verification.ts` is NOT modified for this.
- `mergeVerifyPlans` (verify.ts:705-773) must preserve `origin` verbatim when flattening baseline and final plans.
- Add and export `export function isRunLevelCommand(c: VerifyCommandSpec): boolean { return c.origin !== "declared"; }` in verify.ts; it is the only provenance predicate anyone may use.
**Consequences:** Any future spec source must set `origin` explicitly or be treated as run-level. `VerifyCommandResult` is unchanged (no storyId is introduced). Snapshot-style assertions over plan specs may need the new optional field.
