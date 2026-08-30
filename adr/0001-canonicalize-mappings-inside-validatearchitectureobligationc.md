# ADR-0001: Canonicalize mappings inside validateArchitectureObligationCoverage through one owner function

**Status:** Accepted
**Context:** A paraphrased-but-known `[O-xxx]` claim is rejected today at architecture-obligation-contract.ts:303-309 ("altered canonical") because the validator compares raw acceptance text. The repair already exists (`canonicalObligationAcceptance`, :208-251) but is wired only in planner-validation.ts:110-162; six other call sites (final-tail-tolerance.ts:63, obligation-coverage-report.ts:22, runtime-replan.ts:390/395, progressive-planner-protocol.ts:225/260, progressive-planning-coordinator.ts:353/586, architecture-obligation-contract.ts:376) reach the validator without it. Rewiring each call site independently is exactly the kind of divergence that produces inconsistent behaviour; making the validator itself canonicalize as its first step is one edit and cannot be forgotten.
**Decision:** In packages/baro-orchestrator/src/planning/domain/architecture-obligation-contract.ts add and export:

```ts
export function canonicalizeObligationMappings(
    contract: ArchitectureObligationContractV1,
    mappings: readonly StoryObligationMapping[],
    onNote?: ObligationNoteSink,
): readonly StoryObligationMapping[]
```
It maps each `StoryObligationMapping` through the existing `canonicalObligationAcceptance(contract, mapping.acceptance)` and, per ADR-003, `completeImpliedInvariantIds(mapping.invariantIds, implied)`, returning a new mapping object only when something changed (identity-preserved otherwise). It emits notes via `onNote` (ADR-002). It MUST NOT modify `canonicalObligationAcceptance`, `completeImpliedInvariantIds`, or `renderArchitectureObligationCriterion`.

Change the validator signature to:
```ts
export function validateArchitectureObligationCoverage(
    contract: ArchitectureObligationContractV1 | null | undefined,
    mappings: readonly StoryObligationMapping[],
    mode: ArchitectureObligationCoverageMode,
    onNote?: ObligationNoteSink,
): ArchitectureObligationCoverageResult
```
The `!contract` early return at :282-284 is unchanged. Otherwise the first statement after building `byCriterion`/`byId` is `const effective = canonicalizeObligationMappings(contract, mappings, onNote)`, and the rest of the function iterates `effective` instead of `mappings`. `validatePrdArchitectureObligationCoverage` (:376) gains the same optional trailing `onNote` and forwards it.

Canonicalization is strictly text substitution for ids present in `byId`: an acceptance string whose `[O-xxx]` id is absent from the contract is passed through untouched and still reaches the unknown-id violation. Compound claims (`splitClaimedObligationIds`, :253-258) and duplicate owners remain violations after canonicalization; canonicalization never merges or invents owners. The pass MUST be idempotent — re-running it over already-canonical mappings changes nothing and emits zero notes — so planner-validation.ts:110-162 may keep its existing pre-pass unchanged.
**Consequences:** All seven existing call sites get paraphrase tolerance with no per-site edits; only those with stream access pass `onNote` (ADR-002). `byCriterion` lookup semantics, evidence rules, and everything downstream see byte-identical canonical criterion text as today. The `altered_canonical` violation kind survives in the validator as a backstop for text carrying a known id that canonicalization declined to rewrite; agents must not delete that branch.
