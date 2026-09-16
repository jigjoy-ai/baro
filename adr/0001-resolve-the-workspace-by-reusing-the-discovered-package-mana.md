# ADR-0001: Resolve the workspace by reusing the discovered package-manager entries, not a new discovery routine

**Status:** Accepted
**Context:** The goal requires reusing the existing workspace discovery. `detectCommands` already expands workspace globs into `VerifyJavaScriptPackageManager` entries with absolute `cwd`, and those entries already reach `translatePackage` as `managers`. Exporting `workspacePackageDirs` or re-scanning the disk would duplicate that logic. Changing the discovery mechanism is a non-goal.
**Decision:** 1. In `declared-verification.ts`, add a private function:
   `resolveScriptWorkspace(cwd: string, script: string, managers: readonly VerifyJavaScriptPackageManager[], changedFiles: readonly string[] | undefined): { authority: VerifyJavaScriptPackageManager; rel: string } | { failure: string } | null`
2. Candidate workspaces are `managers.filter(m => m.cwd !== undefined)`.
   - Read each candidate's manifest with the existing `readManifest(join(m.cwd, "package.json"))`.
   - A candidate declares the script when `typeof manifest?.scripts?.[script] === "string"`.
   - `rel` is `relative(cwd, m.cwd)` with backslashes replaced by `/`.
   - Sort candidates by `rel`.
3. The function returns `null` when there are no workspace entries at all (not a monorepo). The caller then keeps today's behavior unchanged.
4. Call it from `translatePackage` only in this case: no explicit selector (`selector.name === undefined`), the root manifest exists, and it does not declare `script`. Put the call where the existing `typeof manifest.scripts?.[script] !== "string"` branch sits (:624).
   - If the root declares the script, root behavior is unchanged.
   - Explicit `-w` / `--workspace` and `cd <dir> &&` paths are unchanged.
5. **Exactly one** workspace declares the script: use it as `workspace`. The spec gets `cwd: authority.cwd` and label `` `${authority.manager} run ${script}${trailingArgs.length ? " " + trailingArgs.join(" ") : ""} (${rel})` ``. The command is `packageCommand(authority, script, trailingArgs)`. The `TRUSTED_PACKAGE_SCRIPTS` check still applies after resolution.
6. **More than one** workspace declares the script, and `changedFiles` is non-empty: pick the candidates for which some changed file equals `rel` or starts with `rel + "/"`.
   - If exactly one matches, use it as in step 5.
   - If zero or several match (or `changedFiles` is absent or empty), return `{ failure }` with text: `multiple workspaces declare script '<script>' and the story's changed files do not select exactly one: <rel1>, <rel2>`.
   - Do NOT fan out to several workspaces.
7. **No** workspace declares the script: return `{ failure }` with text: `no workspace declares script '<script>'; inspected workspaces: <rel1>, <rel2>` (all candidate rels, sorted, comma-plus-space separated).
8. **Focused arguments:** when a workspace is auto-resolved, re-run `safeFocusedArg(authority.cwd, arg)` on the focused arguments. If any fails, return `incomplete` with the existing unsafe-argument reason. Keep the `containedPaths` computation as-is.
9. Do NOT export or change `workspacePackageDirs`, `workspacePatterns`, `detectCommands` or `resolveWorkspaceAuthority`.
**Consequences:** Only `declared-verification.ts` gains resolution logic. Non-monorepo repos and root-declared scripts behave exactly as before. Workspace discovery stays in a single place: `verify.ts`.
