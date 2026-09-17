# ADR-0003: Add optional `changedFiles` to `DeclaredTestRequirement` as the only changed-file input

**Status:** Accepted
**Context:** Scouts confirmed that no verifier receives the story's changed files. Callers that could supply them (`orchestrate.ts`, `finalizer.ts`, `prd.ts`) are outside the allowed edit scope.
**Decision:** 1. In `verify.ts`, extend `DeclaredTestRequirement` with:
   `readonly changedFiles?: readonly string[]`
   The values are repo-relative, `/`-separated paths, relative to the `cwd` passed to `createVerifyPlan`.
2. Normalize inside `resolveScriptWorkspace`:
   - strip a leading `./`
   - replace `\` with `/`
   - ignore entries that are absolute or contain a `..` segment
3. No caller outside `src/verification/` is modified.
4. Do NOT add a git diff inside the verifier.
**Consequences:** Production callers do not yet pass `changedFiles`. Until a later change outside this scope wires them in, a script declared in several workspaces yields an explicit ambiguity failure, which the constraints allow.
