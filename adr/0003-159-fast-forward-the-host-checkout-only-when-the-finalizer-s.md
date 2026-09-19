# ADR-0003: #159: Fast-forward the host checkout only when the Finalizer says verification passed

**Status:** Accepted
**Context:** syncHostCheckout() takes no arguments and runs unconditionally. The checkpoint verdict exists only inside Finalizer.finalize() and is never exposed.
**Decision:** Finalizer (src/integration/finalizer.ts):
- Add a field `private lastCheckpoint: boolean | undefined`, set from the existing `checkpoint` expression.
- Add a public getter `get checkpoint(): boolean | undefined`.

IntegrationWorktree (src/integration/integration-worktree.ts):
- Change the signature to `syncHostCheckout(opts: { verified: boolean }): Promise<HostSyncResult>`.
- When `!opts.verified`, return an untouched result with the new reason `"verification_failed"` (added to the reason union at :35-47), log it via onLog, and do not touch git.

orchestrate.ts:2062: call `integrationWorktree?.syncHostCheckout({ verified: finalizer ? finalizer.checkpoint === false : <the run's existing success flag && the verification result ok> })`. An unknown verdict (undefined) means no fast-forward.

Tests in integration-worktree.test.ts:
- verified:true fast-forwards.
- verified:false leaves the host HEAD SHA unchanged.
Update the existing call sites at :186, :391, :413 and :429 to pass `{ verified: true }`.
**Consequences:** Fails closed: a run with no verdict never moves the host branch. #141 adds a further skip reason to this same function and must merge after #159.
