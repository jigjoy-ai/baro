# ADR-0005: Unwrap paired quotes per token in tokenize, after a widened charset gate and before SAFE_TOKEN

**Status:** Accepted
**Context:** src/verification/declared-verification.ts:111-112 rejects the whole command as soon as any `"` or `'` appears, so a declared command with quoted test paths can never reach SAFE_TOKEN. The unwrap must add zero capability beyond an unquoted token and must preserve every existing error string, including for `echo "a; rm -rf /"`, `foo"bar`, and unpaired quotes. Rejected: a full shell tokenizer (`tokenizeShell` in codebase-tools.ts) — it supports escapes, `$?` and quote-splicing, i.e. strictly more capability, and returns a different shape.
**Decision:** Modify only `tokenize` in src/verification/declared-verification.ts, keeping the order and text of checks 1-3 (non-string, length, trim/empty) and the control-character check unchanged and in its current position:
1. Widen the charset gate at line 111 to `/[^A-Za-z0-9_./:@+=,\-\s"']/` — identical to today except `"` and `'` are permitted through it. Its error string stays `"declared test contains unsupported quoting, shell, or glob syntax"`.
2. Keep the control-character check at 114-115 verbatim.
3. Keep `const raw = normalized.split(/\s+/)`.
4. Add a module-private helper in this same file, placed directly above `tokenize`:
`function unwrapQuotedToken(token: string): string | null` with exactly this behaviour: if `!/["']/.test(token)` return `token`; if `token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]` then `const inner = token.slice(1, -1)`, and return `inner === "" || /["']/.test(inner) ? null : inner`; otherwise return `null`.
5. Map `raw` through `unwrapQuotedToken`; if any element is `null`, return `"declared test contains unsupported quoting, shell, or glob syntax"` (the existing string, reused verbatim — do not introduce a new message).
6. Run the existing `SAFE_TOKEN.test` check over the UNWRAPPED tokens, returning the unchanged `"declared test contains an unsupported argument"`.
7. Return `{ normalized: tokens.join(" "), tokens }` built from the unwrapped tokens.
Do NOT change `SAFE_TOKEN` (29), `MAX_COMMAND_LENGTH` (25), `DeclaredTokens` (37-40), `safeFocusedArg` (407), `trustedScriptAlias` (247-266), any translator, or any caller. Do NOT export `unwrapQuotedToken`.
**Consequences:** `echo "a; rm -rf /"` still fails at the widened gate because of `;` and `/` ordering-independent `;`, returning the unchanged message. `foo"bar` and `"foo` reach step 5 and return that same message. A quoted token containing a space cannot survive (whitespace split happens first and SAFE_TOKEN forbids spaces), so no new capability is introduced. Downstream, `tokens`/`normalized` are quote-free, so translator dispatch on `tokens[0]`, the cargo-fmt label at 600 and `trustedScriptAlias` comparison see plain values; `declaredRequirementKey` hashes change only for commands that previously produced an `incompleteReason`.
