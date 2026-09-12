# ADR-0001: Use the seven #108 ADR files by filename as the binding spec

**Status:** Accepted
**Context:** ADR numbers 0003-0010 collide with unrelated ADRs from main. Those files also carry old line numbers.
**Decision:** The only authoritative files are adr/0003-add-optional-testbudget-*, 0004-validate-testbudget-*, 0006-carry-budget-requests-*, 0007-admit-declared-commands-*, 0008-size-the-merged-watchdog-*, 0009-log-budget-decisions-*, and 0010-place-tests-in-the-existing-files-named-by-the-acceptance-co.md. Find code by the symbol names in Existing context, never by ADR line numbers. Do not edit any adr/ file. Do not edit src/verification/declared-test-budget.ts or crates/baro-tui/src/executor.rs.
**Consequences:** Where these ADRs cite a line, it only locates a symbol. Where this document's decisions are more specific, they refine the ADRs.
