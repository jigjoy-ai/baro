# ADR-0010: #162: Derive the per-command timeout ceiling and never retry a timeout blindly

**Status:** Accepted
**Context:** ABSOLUTE_COMMAND_TIMEOUT_MS (10m) applies to every command. A timeout counts as an ordinary failure and gets the generic retry.
**Decision:** New file packages/baro-orchestrator/src/verification/command-timing.ts:
- `commandKey(cmd): string` = `<cwd relative to repo>::<tool> <args joined>`.
- `loadTimings(repoRoot)` / `recordTiming(repoRoot, key, ms)` persist baroHome()/verification-timings.json as `{ [sha1(canonical repoRoot)]: { [key]: { lastMs: number, at: string } } }`. Writes are atomic (temp file then rename).
- `commandCeilingMs({declaredSecs?, lastMs?})` = max(ABSOLUTE_COMMAND_TIMEOUT_MS, declaredSecs ? declaredSecs*1000 : lastMs ? 2*lastMs : 0).
- The repository declaration is the root package.json key `baro.verification.commandTimeoutsSecs: Record<commandLabel, number>`.

In runCmd:
- Use the ceiling instead of the constant.
- Record the duration only when the command succeeds.
- Mark `timedOut: true` on the result when execFileCli killed the command for the hard limit.

verifyBuild options gain `storyExecutorsActive?: () => boolean`, wired from the board or conductor via RunVerifier. A timed-out command is retried only when that function returns false; otherwise the failure stands with retryable=false.

Warning via onLog: `verification timeout: <label> hit ceiling <C>s (last measured <M>s|none)`.

Tests cover ceiling derivation (declared > measured×2 > floor) and no retry while executors are active.
**Consequences:** The run-level budget helpers (recommendedVerifyTimeoutMs) must use the same ceiling so the run-level watchdog does not undercut it.
