# ADR-0002: Report resolution failures as `preflightFailure`, never as `incompleteReason`

**Status:** Accepted
**Context:** `incompleteReason` produces `status: "skipped"`, which the goal forbids for workspace resolution failures. `preflightFailure` already becomes `status: "failed"` in `runCmd` without spawning anything. The assumption says failure is a plain fail, not a new status.
**Decision:** 1. In `declared-verification.ts`, add a private `declaredFailure(requirement: DeclaredTestRequirement, reason: string): VerifyCommandSpec`.
   - It returns the same shape as `incomplete` (same `label` `PRD test <storyId>: <command>`, `tool: "node"`, `args: []`, same `declaredRequirementKey` computation).
   - It sets `preflightFailure: reason` instead of `incompleteReason`.
   - Put the shared fields in a small helper so the two functions cannot drift apart.
2. `translatePackage` returns `declaredFailure(requirement, result.failure)` for both failure texts from ADR-001.
3. Do not change `runCmd`, `CmdOutcome` or the `status` union in `verify.ts`.
4. If the `translateCdScoped` wrapper (:223-232) receives a spec with `preflightFailure`, return it unchanged. That wrapper is reached only through an explicit workspace, so in practice it will not see one.
**Consequences:** Verification results show the command as failed, with the list of inspected workspaces in `tail`. Implementers must check that dedupe and filter code in `verify.ts` (around :874, :884, :1092) treats a declared `preflightFailure` as failed evidence and does not drop it. If it drops it, adjust only those lines in `verify.ts`.
