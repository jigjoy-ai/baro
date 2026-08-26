# ADR-0008: Rewrite the catch-all message on line 97 to name the three new routes

**Status:** Accepted
**Context:** Acceptance requires the catch-all to name composer, vendor/bin/phpunit and ddev exec. The existing string is asserted in tests and quoted in docs, so its new text must be fixed exactly once here.
**Decision:** Replace the line-97 string with exactly: "unsupported declared test; allowed tools are npm/pnpm/yarn, exact npx rstest run paths, cargo, node, git diff --check, composer, vendor/bin/phpunit, and ddev exec". No other change to the catch-all branch. Any test asserting the old text is updated to this exact string.
**Consequences:** One authoritative string; agents must not paraphrase it in tests or docs.
