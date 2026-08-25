# ADR-0002: Accept a literal two-token `--import tsx` prefix in translateNode, matched before the existing mode gate

**Status:** Accepted
**Context:** `translateNode` reads the mode from `parsed.tokens[1]` (declared-verification.ts:694), so `node --import tsx --test x` dies at the mode gate (:723). The prefix must be recognised without weakening any rejection: `containedPath` rejects any candidate starting with `-` (:661), and the greenfield branch requires `!mode.startsWith("-")` (:704). Alternatives rejected: a general flag-skipping loop (would silently admit `--import ./evil.mjs`, `--require`, `--loader`); a regex over the raw declaration string (bypasses tokenize's safety class).
**Decision:** In `packages/baro-orchestrator/src/verification/declared-verification.ts`, inside `translateNode` and before any other logic (i.e. before the greenfield branch at :701), compute the token slice offset:
```ts
const hasTsxLoader = parsed.tokens[1] === "--import" && parsed.tokens[2] === "tsx"
const loaderArgs: readonly string[] = hasTsxLoader ? ["--import", "tsx"] : []
const rest = parsed.tokens.slice(1 + loaderArgs.length)
```
Then rewrite the body to read from `rest` instead of raw indices: `const mode = rest[0]`, `const candidates = rest.slice(1)`, and the greenfield condition uses `rest.length === 1` in place of `parsed.tokens.length === 2` (every other greenfield condition, including `!mode.startsWith("-")`, `existsSync(join(cwd, "package.json"))`, and `containedPath(cwd, mode, true)`, is unchanged). Matching rules: the prefix is recognised ONLY when `tokens[1]` is exactly `--import` and `tokens[2]` is exactly `tsx`; `--import=tsx`, `--import ./evil.mjs`, `--import other`, `--loader tsx`, `--require tsx`, a repeated `--import tsx --import tsx`, and any prefix not in position 1 are NOT recognised and therefore fall through to the existing mode gate at :723 and are rejected there with the existing `incomplete(...)` reason, unchanged.
Output construction, both branches, keeps the full command form:
- greenfield: `label: ["node", ...loaderArgs, contained.path].join(" ")`, `args: [...loaderArgs, contained.path]`, `containedPaths` unchanged.
- flag mode: `label: ["node", ...loaderArgs, mode!, ...paths].join(" ")`, `args: [...loaderArgs, mode!, ...paths]`, `containedPaths` unchanged.
Do NOT touch `containedPath`, `tokenize`, `SAFE_TOKEN`, `incomplete`, `revalidateContainedPaths`, or the dispatcher at :82. Do NOT add any allow-list entry for other loaders or modules.
**Consequences:** Every existing input shape reaches identical code with identical results: when `hasTsxLoader` is false, `rest` equals the old `tokens.slice(1)` view, `loaderArgs` is empty, and labels/args are byte-identical to today. `revalidateContainedPaths` is unaffected because the new tokens never enter `containedPaths`. Anything other than the exact pair is rejected by the pre-existing gate, so no new rejection message is introduced.
