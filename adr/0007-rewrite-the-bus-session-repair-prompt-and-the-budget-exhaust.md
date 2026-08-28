# ADR-0007: Rewrite the bus-session repair prompt and the budget-exhaustion message around defect lists and flavors

**Status:** Accepted
**Context:** settleOutcome today derives `reason` from one thrown message (:408) and emits a two-sentence repair prompt (:418-422); exhaustion throws a single-line message (:410-412). The goal requires the full defect list in both places plus the flavors repaired across earlier attempts, while DEFAULT_OUTCOME_REPAIRS = 2 (:43) and the `attempt > maxRepairs` guard (:409) must not move.
**Decision:** In src/planning/adapters/architect-bus-session.ts, inside settleOutcome (:377-426):
- Add option `outcomeSchemaSummary?: string` to the session options; scripts/run-architect.ts passes `ARCHITECT_OUTCOME_SCHEMA_SUMMARY` at the :680-705 call site. When the option is absent the repair prompt omits the `Expected schema:` block entirely.
- On a failed `validateOutcome`, compute `const defects = contractDefects(error)` and `const reason = joinDefectMessages(defects)` — with one defect this equals today's `error.message`, so the exhaustion prefix is unchanged for the single-defect case.
- Maintain `const seenFlavors = new Set<string>()` across attempts. Before starting the next attempt, record `defects.map(defectFlavor)` into it. `repairedFlavors` at exhaustion = flavors in `seenFlavors` that are NOT present in the final attempt's defects, sorted alphabetically.
- Repair prompt (replacing :418-422) is exactly:
  `Your outcome was rejected. Fix every defect listed below in one reply.\n\nDefects (${defects.length}):\n${formatDefectList(defects)}\n\nExpected schema:\n${outcomeSchemaSummary}\n\nReply with ONLY the corrected outcome. Change nothing that was already valid, and do not restate this message.`
  (the `Expected schema:` paragraph and its trailing blank line are omitted when no summary is supplied).
- Exhaustion throw (replacing :410-412) is a single `Error` whose message is exactly:
  `architect bus session: outcome rejected after ${attempt} attempt(s): ${reason}\nfinal defects (${defects.length}):\n${formatDefectList(defects)}\nrepaired defect flavors: ${repairedFlavors.length ? repairedFlavors.join(", ") : "none"}`
  It keeps the existing `architect bus session: ` prefix and stays a thrown Error — no partial or degraded return value is introduced.
- Unchanged: DEFAULT_OUTCOME_REPAIRS, maxOutcomeRepairs resolution (:242) and threading (:291, :326), the `attempt > maxRepairs` guard position (:409), `attempt += 1` (:417), the mid-repair-exit throw (:393-395), the progress line (:414-416), and the success return shape (:401-406).
**Consequences:** Repair rounds collapse from one-defect-at-a-time to one round per model mistake set, without changing how many rounds are allowed. The exhaustion message is multi-line; any consumer matching on it must match a prefix, not the whole string (no such consumer exists today). Because `contractDefects` falls back to a single synthetic defect, validators that were not converted still work through this path unchanged.
