# ADR-0002: Export systemPrompt without changing its signature

**Status:** Accepted
**Context:** The test has to import the function. Its only caller is in the same file (:267), and nothing else imports it.
**Decision:** Change `function systemPrompt(cwd: string): string {` to `export function systemPrompt(cwd: string): string {`. Nothing else changes.
**Consequences:** The module's public surface gains one pure function. `scripts/operator.ts` still imports only `runOperator`.
