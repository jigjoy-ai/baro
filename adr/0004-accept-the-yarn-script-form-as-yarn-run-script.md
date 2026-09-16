# ADR-0004: Accept the `yarn <script>` form as `yarn run <script>`

**Status:** Accepted
**Context:** The goal names `yarn <script>` as a supported form. Today `translatePackage` rejects any second token other than `test` or `run` (:549-555).
**Decision:** 1. In `translatePackage`, when `parsed.tokens[0] === "yarn"` and `tokens[1]` is neither `test` nor `run`, treat the command as `run` with the tokens `["yarn", "run", ...tokens.slice(1)]`. Apply this only if `tokens[1]` matches `SAFE_SCRIPT_NAME` and does not start with `-`.
2. Keep the existing error message for `npm` and `pnpm`.
3. No other forms are added.
**Consequences:** The resulting command still comes from the detected authority through `packageCommand`, so the manager the PRD wrote is not trusted.
