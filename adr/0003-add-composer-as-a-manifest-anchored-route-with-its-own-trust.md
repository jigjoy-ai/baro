# ADR-0003: Add composer as a manifest-anchored route with its own trusted-baseline set

**Status:** Accepted
**Context:** translatePackage (:293-374) is the manifest-anchored precedent: SAFE_SCRIPT_NAME, manifest read at cwd, script-declared check, trusted-set check, then a canonicalized `run <script>` emission. composer must follow it, but composer's conventional baseline includes `check`, and neither set may widen the other.
**Decision:** Add module-private `const TRUSTED_COMPOSER_SCRIPTS = new Set(["build", "typecheck", "test", "lint", "check"])` immediately after TRUSTED_PACKAGE_SCRIPTS (:28). Do NOT add any member to TRUSTED_PACKAGE_SCRIPTS and do NOT reference TRUSTED_PACKAGE_SCRIPTS from the composer path. `translateComposer(cwd, requirement, parsed)` accepts exactly two shapes from parsed.tokens: `["composer", script]` and `["composer", "run", script]`. Checks, in this exact order, each returning incomplete(requirement, reason) with this exact wording:
1. shape not one of the two above (missing script, or `run` with no script) → "composer tests must use 'composer <script>' or 'composer run <script>'"
2. any token after the script name → "composer tests must not pass arguments after the script name"
3. !SAFE_SCRIPT_NAME.test(script) → `unsafe composer script name '${script}'`
4. join(cwd, "composer.json") missing or not valid JSON object → "declared composer test requires a valid root composer.json"
5. typeof manifest.scripts?.[script] !== "string" AND not an array of strings → `composer.json does not declare script '${script}'` (composer allows a string or an array of strings for a script body; accept both, validate nothing further about the body)
6. !TRUSTED_COMPOSER_SCRIPTS.has(script) → `custom composer script '${script}' is not trusted by the baseline verifier policy`
On success return exactly `{ label: `composer run ${script}`, tool: "composer", args: ["run", script] }` — no containedPaths, no cwd, no canonicalDeclaredFocus. Read composer.json with the same defensive JSON reader style as readManifest (:existing helper); if readManifest is typed to package.json shape, add a private `readJsonObject(path): Record<string, unknown> | null` rather than loosening readManifest.
**Consequences:** `composer test` and `composer run test` both emit the identical canonical spec, so verifyCommandIdentity dedupes them. Trailing-argument support is closed by construction, matching the non-goal. The two trusted sets are textually independent; adding to one cannot widen the other.
