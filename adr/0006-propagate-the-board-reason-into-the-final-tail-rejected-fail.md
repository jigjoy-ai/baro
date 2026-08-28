# ADR-0006: Propagate the board reason into the `final_tail_rejected` failure message

**Status:** Accepted
**Context:** Acceptance requires the generic `'the final planner tail could not be durably admitted'` string to be replaced by the propagated board reason in the failing case; `failPlanning` already renders `"${code}: ${reason}"` into `terminalReason`.
**Decision:** Keep the failure code `"final_tail_rejected"` (do not rename; it is referenced nowhere else in the repo). In the not-tolerated branch call:
`this.failPlanning(this.opts.host.snapshot().prd?.runtimeGraph?.planning ?? planning, "final_tail_rejected", `${rejection.code}: ${rejection.reason} (tail not redundant: ${tolerance.blocker}: ${tolerance.detail})`)` and return. The literal `"the final planner tail could not be durably admitted"` is deleted from the file and must appear nowhere in `packages/baro-orchestrator/src`. `failPlanning` and `closePlanning` themselves (:669-725) are not modified.
**Consequences:** Terminal reason becomes e.g. `final_tail_rejected: graph_rejected: cannot add existing story 'S3' (tail not redundant: obligation_unowned: no admitted story owns: O-004)`. Any test asserting the old literal must be updated; scouts found no such assertion exists.
