# ADR-0002: Fix the exact denylist contents and the audited exclusions

**Status:** Accepted
**Context:** The goal names a minimum of sessionId, goalRequestId, architectRequestId, runId and requires the rest to come from an audit of run-architect.ts and the outcome/obligation transports, with a written rationale. Two failure modes must be avoided: missing a field the host actually stamps, and denying a generic word a model could legitimately use in a contract field.
**Decision:** `HOST_ASSIGNED_CORRELATION_FIELDS` is exactly these 19 entries, in this order, each with a one-line `//` rationale in the source and repeated in the PR description:

"sessionId", "conversationSessionId" (transport envelope, architect-outcome.ts:122-128, stamped :480-489 from --conversation-session-id, run-architect.ts:177-185)
"goalRequestId", "architectRequestId" (same envelope, same stamping site)
"runId", "billingRunId" (billing envelope, run-architect.ts:325, :786-799)
"messageId" (per-call billing envelope, run-architect.ts:786-799)
"billingPhase", "billingAttempt" (same envelope, same lines)
"invocationId", "invocationBaseId", "measurementId" (model_usage measurement context, run-architect.ts:908-935)
"storyId", "workerId" (host-assigned execution identity, measurement context run-architect.ts:908-935)
"batchId", "batchOrdinal" (obligation compilation identity, architect-obligation-segments.ts:210-211, :346-357)
"snapshotId" (host-owned repository snapshot identity from the RepositoryBrief)
"traceId", "requestId" (generic host correlation spellings reserved so a provider cannot introduce them later)

Explicitly NOT denylisted, and stated as such in the PR description: "id" (obligation drafts legitimately carry a model-supplied `id` that the host discards, architect-obligation-segments.ts:485-509 — denying it would break obligation parsing), "schemaVersion" (a real contract field, architect-outcome.ts:61-69), and the bare generic words "attempt", "phase", "backend", "requestedModel" (host-side telemetry only, never stamped on the outcome or obligation record itself, and plausible prose field names).
**Consequences:** Adding a field later is a one-line edit in this list plus a PR-description rationale line; no call site changes. Because matching is canonical, the list must contain only camelCase source spellings — adding snake_case variants would be dead weight. The unit test asserting the list must assert membership of `id` and `schemaVersion` being ABSENT, so a future careless addition breaks loudly.
