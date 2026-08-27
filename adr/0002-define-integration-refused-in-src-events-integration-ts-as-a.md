# ADR-0002: Define `integration_refused` in src/events/integration.ts as a purely additive event

**Status:** Accepted
**Context:** Refusal today is only expressible as `StoryMergeFailed.error` free text. Conventions require a snake_case frozen wire type, a plain TS data interface, string-literal unions for enumerated reasons (see events/runtime-graph.ts:95-116), and no zod. `IntegrationRefusalInvariant` already exists in worktree.ts:71-78 and should be reused rather than re-spelled; events/market.ts:4 shows a precedent for an events module importing a type from a domain module.
**Decision:** In packages/baro-orchestrator/src/events/integration.ts add:
```ts
import type { IntegrationRefusalInvariant } from "../integration/worktree.js"

/** Coordinator-level refusals that happen before any worktree invariant runs. */
export type IntegrationRefusalCode =
    | IntegrationRefusalInvariant
    | "seal_missing"
    | "fingerprint_missing"
    | "worktree_missing"
    | "unknown"

export interface IntegrationRefusedData {
    runId: string | null
    storyId: string
    leaseId: string | null
    /** The single invariant that refused this candidate. */
    invariant: IntegrationRefusalCode
    /** Message from the refusing error; advisory only, never parsed. */
    detail: string
    /** Immutable recovery ref (`baro-recovery/...`) or null. */
    recoveryRef: string | null
    /** The isolated worktree still exists on disk for this story. */
    worktreeRetained: boolean
    /** false ⇒ the candidate's work is lost forever. */
    recoverable: boolean
    /** The run may re-offer this story; mirrors StoryMergeFailed.retryable. */
    retryable: boolean
    /** Logical story branch, when known. */
    branch: string | null
}

export const IntegrationRefused =
    defineSemanticEvent<IntegrationRefusedData>("integration_refused")
```
`recoverable` MUST be computed as `recoveryRef !== null || worktreeRetained`. Do NOT change `StoryMergeFailedData` or any existing wire `type` string. Do NOT add zod or any new dependency. `src/semantic-events.ts` already re-exports `./events/integration.js`, so no barrel edit.
**Consequences:** Consumers can distinguish 'lost forever' (`recoverable: false`) from 'retryable' without parsing prose. The event is additive: existing subscribers are unaffected. Adding it to the frozen-string set means `"integration_refused"` may never be renamed.
