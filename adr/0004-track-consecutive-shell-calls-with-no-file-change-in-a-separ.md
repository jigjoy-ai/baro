# ADR-0004: Track consecutive shell calls with no file change in a separate, non-derived supervisor counter defaulting to 240

**Status:** Accepted
**Context:** supervisor.ts:196-206 fully exempts bash from sinceLastChange, so a shell-only loop never trips. The existing test at test/execution/supervisor.test.ts:47-66 constructs the supervisor with noProgressToolCalls: 5 and feeds 20 bash calls expecting zero interventions, so deriving the shell threshold from noProgressToolCalls (e.g. 3x) would break that test. The threshold must therefore be an independent option with a fixed default.
**Decision:** In `packages/baro-orchestrator/src/execution/supervisor.ts`:
- Add option `noProgressShellCalls?: number`, resolved as `this.noProgressShellCalls = opts.noProgressShellCalls ?? 240` next to the existing `noProgressToolCalls ?? 80` (:90). It is NOT derived from noProgressToolCalls.
- Add StoryProgress field `shellSinceLastChange: number` (:64-76), initialized to 0 in `ensure()` (:280-296) and therefore also cleared by `resetAttempt` (:298-301) and by WorkLeaseReleased state deletion.
- In the file-mutation branch (:189-195) add `st.shellSinceLastChange = 0` alongside the existing `st.sinceLastChange = 0`.
- In the shell branch (:196-206) add `st.shellSinceLastChange += 1` and keep everything else byte-identical: `st.lastVerificationAt = now()`, `st.pendingShell.add(item.callId)`, and NO `sinceLastChange` increment.
- Do not touch `onExternalFunctionCallOutput` (:240-257); lastVerificationAt on shell completion is unchanged.
- In `stallReason` (:259-278), insert the new check immediately AFTER the existing `sinceLastChange >= noProgressToolCalls` check and BEFORE the repeat detector: `if (st.shellSinceLastChange >= this.noProgressShellCalls) return \`${st.shellSinceLastChange} shell commands with no file change — probing, not converging\`` . The reason must contain the literal substring `shell commands with no file change`.
- Do not add shellSinceLastChange to the repeat-detector gate (:266) and do not change the wall-clock softCap check (:269-276).
**Consequences:** Read-only exploration keeps priority in the reason string when both counters trip. The existing 20-bash test stays green because 20 < 240 and its noProgressToolCalls: 5 no longer influences shell accounting. New tests must pass an explicit small `noProgressShellCalls` to trip the counter cheaply. Only bash-normalized names count (isShellCommand, :327-329) — do not switch to isShellTool in this change.
