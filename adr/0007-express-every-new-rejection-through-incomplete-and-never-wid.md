# ADR-0007: Express every new rejection through incomplete() and never widen the accept surface of tokenize()

**Status:** Accepted
**Context:** The file has no ok/reason union; incomplete() supplies the label, the empty args and the deterministic declaredRequirementKey that downstream evidence depends on. Any new route that returned a bespoke shape would break verifyCommandIdentity and the evidence hash.
**Decision:** All new rejection paths call `incomplete(requirement, reason)` and return its value directly; never construct `{incompleteReason}` by hand and never throw. Do not modify tokenize(), SAFE_TOKEN, unwrapQuotedToken, MAX_COMMAND_LENGTH, the charset gate, or containedPath() — the existing SAFE_TOKEN charset already admits `vendor/bin/phpunit`, `-c`, `--testsuite` and `.ddev/config.yaml`-style tokens. Reason strings are lowercase, no trailing period, and interpolate untrusted values only inside single quotes, exactly as the existing messages do.
**Consequences:** New routes produce evidence indistinguishable in shape from existing ones. Because tokenize is untouched, every pre-existing quoting/charset/length rejection stays bit-identical.
