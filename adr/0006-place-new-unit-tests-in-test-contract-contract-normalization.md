# ADR-0006: Place new unit tests in test/contract/contract-normalization.test.ts using the existing house style

**Status:** Accepted
**Context:** src/contract has exactly one module and one mirrored test file, test/contract/contract-normalization.test.ts, which already uses node:test describe/it, node:assert/strict, a local `recorder()` helper returning {notes, sink}, 4-space indent, and `.js`-suffixed relative imports. The acceptance criteria demand outcome-flavor and obligation-flavor rejection tests, a benign-strip test, and an all-else-valid test.
**Decision:** Add ONE new `describe("host-assigned correlation fields")` block to packages/baro-orchestrator/test/contract/contract-normalization.test.ts containing exactly these cases, all driving `normalizeRecordKeys` directly (no CLI spawn):

1. outcome flavor: `normalizeRecordKeys({ schemaVersion: 1, kind: "ready", sessionId: "x" }, ["schemaVersion", "kind"], "", sink)` throws ContractAuthorityFieldError; assert `error.field === "sessionId"`, `error.path === ""`, message matches `/model output may not carry host-assigned correlation/` and contains `"sessionId"`, and `notes.length === 0`.
2. obligation flavor: same call with path `"obligations[0]"` and expected keys `["invariantId", "text"]`, forging `runId`; assert `error.path === "obligations[0]"`, `error.field === "runId"`, and `defectFlavor({ path: error.path, message: error.message }) === "obligations"`.
3. canonical spelling variants: `session_id`, `SessionID`, `goal-request-id` each rejected with `error.field` echoing the model's spelling verbatim.
4. benign field preserved: an unexpected `vibes` key is still dropped and produces exactly the note `{ severity: "warn", kind: "stripped_unexpected_field", path: "", detail: ': dropped unexpected field "vibes"' }`, and the returned record equals the expected keys only.
5. everything-else-valid: a record whose every other key is an exact expected spelling plus one denylisted key still throws (denylist precedes success).
6. precedence over collision: a record containing both a denylisted key and two keys colliding on one expected key throws ContractAuthorityFieldError, not the collision ContractNormalizationError.
7. list audit: `HOST_ASSIGNED_CORRELATION_FIELDS` includes sessionId, goalRequestId, architectRequestId, runId, and does NOT include `id` or `schemaVersion`.

Do not create any new test file under test/contract/.
**Consequences:** test/contract/ stays in the fast lane (scripts/test-lanes.mjs:9-29 has no matching slow pattern). Case 7 makes the audit machine-checked rather than PR-prose only. Obligation-flavor coverage lives in the shared module test, so architect-obligation-segments.test.ts needs a change only for the nested-evidence guard.
