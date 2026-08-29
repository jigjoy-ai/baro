# ADR-0003: Fix the rejection message wording, and preserve the `exact v1 schema` substring on the outcome path

**Status:** Accepted
**Context:** packages/baro-orchestrator/test/run-architect-outcome.test.ts:437-449 must pass unchanged and asserts `assert.match(run.stderr, /exact v1 schema/)`. Today that substring comes from architect-outcome.ts:336-338 (`architect outcome must use the exact v1 schema`), which is reached only because normalizeOutcomeRecord strips sessionId first. Once the denylist rejects earlier, that string would disappear from stderr and the named test would fail. The goal also requires the reason to name the field and explain why.
**Decision:** `ContractAuthorityFieldError` message format, produced in its constructor and used verbatim on every flavor:

`${path}: field "${field}" is host-assigned correlation; model output may not carry host-assigned correlation`

(top-level records use `path === ""`, yielding a leading `: `, matching the existing note convention at contract-normalization.ts:109-114).

In packages/baro-orchestrator/src/planning/domain/architect-outcome.ts, the existing catch in normalizeOutcomeRecord (:638-645) gains a branch placed BEFORE the generic ContractNormalizationError branch:

```
if (error instanceof ContractAuthorityFieldError) {
    throw new ArchitectOutcomeContractError(
        `architect outcome must use the exact v1 schema: ${error.message}`,
        { defects: [{ path: error.path, message: error.message }] },
    )
}
```

The generic ContractNormalizationError branch keeps its current message and defect shape unchanged. normalizeEntry (:619-627) is NOT given its own catch; authority errors raised for `questions[i]` / `evidence[i]` propagate to the same handler that already wraps sub-parser failures, and their defect `path` is the entry path supplied to normalizeRecordKeys.

In packages/baro-orchestrator/src/planning/domain/architect-obligation-segments.ts, the catch at :805-813 is left as-is: ContractAuthorityFieldError is a ContractNormalizationError, so it is rethrown as ArchitectObligationSegmentError with `defects: [{ path: error.path, message: error.message }]` and no `exact v1 schema` prefix (that phrase is outcome-specific and must not be invented for obligations).
**Consequences:** stderr on the CLI path contains both the schema phrase (keeping run-architect-outcome.test.ts:437-449 green unchanged) and the field-naming reason. defectFlavor (contract-normalization.ts:138-142) classifies the outcome-root defect as "outcome" (path "") and obligation-root/entry defects by their first path segment, so architect-bus-session.ts:426-434 repair reporting keeps working with no edit. Do not add the schema phrase inside contract-normalization.ts.
