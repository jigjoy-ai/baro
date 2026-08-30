# ADR-0001: Match goal constraint predicates by index, then by unique invariantId, never by field subset

**Status:** Accepted
**Context:** Canonicalizing drifted `constraintPredicates` requires matching each raw entry to a canonical entry before restoration. `parsePredicate` does not enforce `invariantId` uniqueness, so `invariantId` alone is not a reliable key. Null/undefined holes in the raw array are skipped and the array is compacted, so a dropped entry shifts every later index and index alone is unsafe when used past the point of a hole. Field-subset matching (comparing `kind`/`pathPrefix`/`pathSuffix`/`text`) is unusable here specifically because those are the fields expected to have drifted, making them the least reliable signal for identity in the case the rule exists to serve.
**Decision:** Match candidates are found by a private two-pass procedure operating on the raw array, including holes, before any hole skipping or key normalization:

Pass 1 (index): for each `i` in `0 .. min(raw.length, canonical.length) - 1`, if `identityOf(raw[i]) === canonical[i].invariantId` and canonical index `i` is still unclaimed, claim the match `raw[i] -> canonical[i]`.

Pass 2 (unique id): for each raw index `i` still unmatched after pass 1, taken in ascending order, where `identityOf(raw[i])` is non-null, collect the still-unclaimed canonical indices whose `invariantId` equals that identity. Claim the match only when exactly one such canonical index remains; zero or more than one leaves `raw[i]` unmatched.

`identityOf(entry)` is `entry.invariantId.trim()` when `entry` is a non-null, non-array object with a string `invariantId`, and `null` otherwise. There is no third pass: non-object entries, holes, and entries whose `invariantId` is missing, non-string, or spelled under a different key (e.g. `invariantID`) are never matched.

Every raw index left unmatched after both passes, and every canonical index left unclaimed after both passes, is rejected fail-closed: unmatched raw entries surface as a `ContractDefect` reporting that the entry does not match any canonical constraint predicate, and unclaimed canonical entries surface as a `ContractDefect` reporting that the canonical predicate is missing. Both accumulate into the same defect list the entry loop already throws through; no new error vocabulary is introduced.

Rejected alternatives:
- Field-subset matching — the drifted fields (`kind`, `pathPrefix`, `pathSuffix`, `text`) are exactly the ones expected to be unreliable, so matching on them would be least trustworthy in the case this rule exists to handle.
- `invariantId` alone, without index — `parsePredicate` does not enforce that `invariantId` is unique across predicates, so an id alone can be ambiguous.
- Index alone, without id — null/undefined holes are skipped and the array compacted, so a dropped entry shifts every later index out of alignment with canon.
- A shared canonicalization helper across the architect-obligation, planner-obligation, and goal-constraint repair sites — the three recipes canonicalize different data (acceptance text vs. positional ids vs. whole predicate records) under different match keys, and forcing a common abstraction would contort at least one of them.
**Consequences:** A predicate whose `invariantId` drifted and whose position also moved is left unmatched and rejected rather than guessed at, which is the intended fail-closed behavior for meaning drift. Restoration is deterministic and does not depend on the raw array's shape beyond identity and position.
