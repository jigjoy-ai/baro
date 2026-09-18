# ADR-0005: #136: Build the branch slug from the Objective line

**Status:** Accepted
**Context:** The rendered prompt begins with the header 'Goal envelope (confirmed before planning)', so slugging the first line produces goal-envelope-confirmed-before-planning.
**Decision:** Rust (crates/baro-tui/src/progressive_planning.rs):
- Add `fn planning_objective(goal: &str) -> &str`. If the trimmed goal starts with "Goal envelope (confirmed before planning)", return the first non-empty trimmed line after the line equal to "Objective:". Otherwise return the goal unchanged.
- deterministic_bootstrap_metadata slugs planning_objective(goal). The hash suffix still uses the full description.
- Test: build a fixture with contract.rs render_planning_prompt and assert the exact slug prefix derived from its objective.

TS:
- New file packages/baro-orchestrator/src/planning/domain/goal-objective.ts exports `objectiveLine(goal: string): string` with the same rule.
- planner-openai.ts fallbackPrdJson title uses objectiveLine(goal).
- Test in test/planner-openai.test.ts: a rendered-prompt fixture string gives `baro/<objective-slug>`.
**Consequences:** The header string is duplicated once in TS as a constant. Both sides must match the exact text in contract.rs:107-110.
