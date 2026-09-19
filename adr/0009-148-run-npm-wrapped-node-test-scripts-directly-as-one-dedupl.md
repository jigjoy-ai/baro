# ADR-0009: #148: Run npm-wrapped node --test scripts directly, as one deduplicated invocation

**Status:** Accepted
**Context:** Declared tests resolve to `npm run <script> -- <files>`, one command per file group. The script is itself a `node --test` glob, so the declared files get appended to the glob and run as extra groups.
**Decision:** New file packages/baro-orchestrator/src/verification/node-test-script.ts exports `coalesceNodeTestScripts(commands: VerifyCommand[], readPackageJson?): VerifyCommand[]`. It is applied at the end of createVerifyPlan in verify.ts.

For each command where javascriptCommandDetails reports `run <script>` and the script in the command's cwd package.json tokenizes as `node [flags] --test [flags] <globs>`:
- Collect the trailing file args of all such commands with the same cwd and script.
- Replace them with ONE command: `{tool:"node", args:["--import","tsx", ...scriptFlagsExcept(--import tsx, --test, globs), "--test", ...dedupedSortedFiles]}`.
- If no files were declared, use the script's globs.
- The label becomes `node --test (<script>)`.

Anything that does not match that shape is left unchanged.

Test: fixture test/fixtures/node-test-script/package.json with test = `node --import tsx --test --test-concurrency=2 "test/**/*.test.ts"`. Two declared groups sharing one file produce one command with deduped files and --test-concurrency=2 kept.
**Consequences:** #162 and #163 also edit verify.ts, so #148 goes first.
