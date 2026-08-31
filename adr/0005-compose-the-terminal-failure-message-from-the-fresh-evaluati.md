# ADR-0005: Compose the terminal failure message from the fresh evaluation while preserving the pinned prefixes

**Status:** Accepted
**Context:** The failure text at :704-714 is regex-pinned: `/^final_tail_rejected: /` (test:90), the `blocker: ` label (test:110-112) and the negative pin against `could not be durably admitted` (test:98). The bug is the data fed into the template, not the template.
**Decision:** Keep both strings structurally identical and feed them from the second (fresh) evaluation of ADR-004:
- activity: `emitPlanActivity("error", `final planner tail rejected (${rejection.code}): ${rejection.reason}; blocker: ${fresh.tolerance.blocker}: ${fresh.tolerance.detail}`)`
- failure: `this.failPlanning(fresh.planning, "final_tail_rejected", `${rejection.code}: ${rejection.reason} (tail not redundant: ${fresh.tolerance.blocker}: ${fresh.tolerance.detail})`)`
Pass `fresh.planning` (the freshly read planning state), not the caller's entry-time `planning`, as the first argument to `failPlanning`. `failPlanning` (:763-771), `controlText` (:857-864) and `closePlanning` (:773-819) — including its own snapshot at :778 and the open/identity guards at :780-788 — are unchanged. `FinalTailDiscarded` payload and the `final-<sha256>` fragment-id shape (:633) are unchanged.
**Consequences:** A story settled by decision time can no longer be named in `unsettled_stories` detail, because the detail comes from the freshest evaluation. All anchored substrings (`final_tail_rejected: `, `blocker: `, `tail not redundant: `, `dropped stories: `) survive, so the regex assertions in test/planning/progressive-planning-final-tail.test.ts keep passing apart from the call-count update named in ADR-004.
