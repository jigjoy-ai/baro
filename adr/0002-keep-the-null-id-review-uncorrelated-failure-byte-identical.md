# ADR-0002: Keep the null-id `review_uncorrelated` failure byte-identical

**Status:** Accepted
**Context:** The goal explicitly preserves today's behaviour for a terminal without stable identity, and the two `review_uncorrelated` producers are distinguished only by their `error` string; removing one must not perturb the other.
**Decision:** Leave src/acceptance/turn-review.ts:197-206 exactly as-is: the falsy test `if (!terminalId)` (so `""` still takes this branch), the message `"quality review requires a stable terminal turn identity"`, and the failure object `{ kind: "infrastructure", code: "review_uncorrelated" }` routed through `fail()`. Do not add a `code` for supersession, do not introduce any new member of `InfrastructureFailureCode` in src/events/execution.ts:347-349, and do not modify src/harness/one-shot/turn-review.ts:150-163.
**Consequences:** After this change `review_uncorrelated` has exactly one producer in src/acceptance/turn-review.ts. Any downstream consumer keying on the code keeps working for the missing-identity case.
