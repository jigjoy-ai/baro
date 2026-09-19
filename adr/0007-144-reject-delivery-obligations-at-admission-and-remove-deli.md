# ADR-0007: #144: Reject delivery obligations at admission and remove delivery from the operator prompt

**Status:** Accepted
**Context:** Obligations are admitted in architecture-obligation-contract.ts: architect bind at :151, planner coverage at :395. The operator prompt source is in baro-orchestrator/src/operator, not baro-app.
**Decision:** Admission check:
- New file packages/baro-orchestrator/src/planning/domain/delivery-obligation.ts exports `deliveryObligationViolation(text: string): string | null`.
- It matches /\b(push|pushe[sd]|pushing|publish|publishe[sd]|publishing)\b/i.
- It does NOT match when a negation (no|not|never|don't|do not|without|deny|denied|refuse[sd]?) appears earlier in the same sentence. This keeps constraints like 'stories do not run git push' admissible.
- bindArchitectureObligationContract and validateArchitectureObligationCoverage both call it for every obligation and reject with code `delivery_obligation`.
- Test: an obligation 'Push the branch and publish a PR' is rejected by both paths.

Operator prompt, in packages/baro-orchestrator/src/operator/operator-session.ts:
- Delete every sentence describing delivery (push, PR, publishing).
- Do not hand-edit packages/baro-app/dist.
**Consequences:** The #141 prompt edit touches the same file, so #141 runs after this story.
