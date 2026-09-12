# ADR-0001: Own all declared-test budget logic in a new import-free leaf module

**Status:** Accepted
**Context:** prd.ts, the planning gates, the runtime gates and verify.ts all need the same constants and the same accept/reject logic. Importing from verify.ts or declared-verification.ts risks import cycles. The constraint also forbids editing translator code, and allows only the budget constant to move out of declared-verification.ts.
**Decision:** New file: src/verification/declared-test-budget.ts, with ZERO imports. It exports:
- `export const MAX_DECLARED_VERIFY_COMMANDS = 8`, moved here. Delete line 26 of declared-verification.ts and change nothing else in that file.
- `export const MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS = 24`
- `export interface DeclaredTestBudgetRequest { readonly storyId: string; readonly testBudget: unknown }`
- `export interface DeclaredBudgetDecision { readonly storyId: string; readonly status: 'accepted' | 'rejected'; readonly commands: number | null; readonly detail: string }`. For accepted requests `detail` is the story's reason; for rejected requests it is the rejection text.
- `export interface DeclaredBudgetEvidence { readonly defaultLimit: number; readonly ceiling: number; readonly effectiveLimit: number; readonly negotiatedBy: string | null; readonly decisions: readonly DeclaredBudgetDecision[] }`
- `export type TestBudgetJudgement = { readonly accepted: true; readonly commands: number; readonly reason: string } | { readonly accepted: false; readonly rejection: string }`
- `export function judgeTestBudget(value: unknown): TestBudgetJudgement`
- `export function resolveDeclaredBudget(requests: readonly DeclaredTestBudgetRequest[]): DeclaredBudgetEvidence`
- `export function formatDeclaredBudgetEvidence(evidence: DeclaredBudgetEvidence): string[]`

Re-exports:
- verify.ts: replace the import/re-export at :25/:30 with imports from './declared-test-budget.js'. Re-export `MAX_DECLARED_VERIFY_COMMANDS`, `MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS` and the types `DeclaredTestBudgetRequest`, `DeclaredBudgetDecision`, `DeclaredBudgetEvidence`.
- main.ts: add `MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS`, `readAuthoritativeVerifyPlanOptions` and the three types next to the existing verify exports.
**Consequences:** Existing test imports of `MAX_DECLARED_VERIFY_COMMANDS` from verify.js keep working. prd.ts and the planning/runtime gates import `judgeTestBudget` from this leaf only, never from verify.ts. declared-verification.ts gets exactly a one-line deletion, which keeps merge conflicts with #109 minimal.
