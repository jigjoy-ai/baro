# ADR-0003: Fix the exact rejection reason string for overlapping write surfaces

**Status:** Accepted
**Context:** The acceptance criterion requires the reason to name the overlapping paths and the owning story. Reasons are plain strings asserted on in tests, so the format must be pinned or two agents will assert different text.
**Decision:** The reason is exactly:
`overlapping write surface: story '<addedStoryId>' writes <paths> already owned by story '<ownerStoryId>'`
where `<paths>` is the sorted shared normalized paths joined with `", "` (comma + single space). Single quotes around story ids, no quotes around paths, no trailing period. Tests must assert with `assert.match` on this shape or `assert.equal` on the full string — either is acceptable, but the produced string must match the template character for character.
**Consequences:** Deterministic output for identical inputs (sorted paths, first-conflict-wins ordering), so assertions are stable under concurrent test execution.
