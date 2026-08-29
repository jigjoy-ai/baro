# ADR-0002: Surface warn notes through an optional NoteSink callback parameter, never through changed return shapes

**Status:** Accepted
**Context:** Notes must reach the operator, but goal-constraint-appendix's validator returns a bare array, attachGoalConstraintContract returns a string, and compileArchitectObligationSegments returns a frozen literal read for one field by a single caller. Changing those return shapes would ripple into architect-outcome.ts, goal-precondition-report.ts and run-architect.ts for no benefit, and adding fields to the outcome ENVELOPE is unsafe because crates/baro-tui/src/architect_runner/outcome.rs:180-185 exact-key-checks it. A module-level note buffer would be shared mutable state.
**Decision:** Add an optional trailing `onNote?: NoteSink` parameter to the validation entry points; no existing return type changes anywhere, and no new key is ever added to the architect outcome JSON envelope.
- `validateGoalConstraintPredicates(value: unknown, onNote?: NoteSink)` (src/goal/goal-constraint-appendix.ts:57).
- `parseGoalConstraintContract(decisionDocument, onNote?)` forwards its sink.
- `parseArchitectOutcome(raw, onNote?)` in src/planning/domain/architect-outcome.ts — appended as the LAST parameter after any existing ones; it forwards the same sink into `validateGoalConstraintPredicates` at :308-310.
- `compileArchitectObligationSegments(options)` gains an optional `onNote?: NoteSink` field on its options object; the frozen result literal at architect-obligation-segments.ts:214 is NOT changed.
- `runArchitectBusSession(opts)` gains optional `onNote?: NoteSink` (src/planning/adapters/architect-bus-session.ts).
When `onNote` is undefined, notes are computed and discarded — normalization behaviour is identical either way.
Operator output: scripts/run-architect.ts is the ONLY place that prints notes. It passes a sink that writes `` `[architect] ${note.detail}\n` `` to `process.stderr`, matching the existing `[component]`-prefixed stderr convention (mode-enforcement.ts:46). Domain modules must not write to stderr.
**Consequences:** Tests observe notes by passing a push-into-array closure, matching the existing recorder style in the two test files. No caller of the four functions above needs editing except to opt in. The Rust TUI envelope check stays valid because no envelope field is added; drift arriving at the TUI is out of scope for this run.
