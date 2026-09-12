# ADR-0002: Judge requests with fixed order and exact rejection strings

**Status:** Accepted
**Context:** The planner gates and verify-plan admission must accept and reject identically, and rejections must name a concrete reason.
**Decision:** `judgeTestBudget(value)` checks in this order and returns the first failure:
1. `value` is not a plain non-array object: 'testBudget must be an object with integer commands and a non-empty reason'
2. `reason` is not a string, or `reason.trim() === ''`: 'testBudget.reason must be a non-empty string'
3. `!Number.isInteger(commands)`: 'testBudget.commands must be an integer'
4. `commands <= MAX_DECLARED_VERIFY_COMMANDS`: 'testBudget.commands must be above the default 8' (the number comes from the constant)
5. `commands > MAX_NEGOTIATED_DECLARED_VERIFY_COMMANDS`: 'testBudget.commands must be at most 24' (the number comes from the constant)

Otherwise it returns `{accepted:true, commands, reason: reason.trim()}`. Extra keys are ignored.

`resolveDeclaredBudget` builds one decision per request, in input order:
- Accepted: `commands` is the request's value. `detail` is the reason cut to 200 chars, with control characters and backticks replaced by '?'.
- Rejected: `commands` is the raw value if it is a number, otherwise null. `detail` is the rejection text.
- `effectiveLimit` is the largest accepted `commands`, or `MAX_DECLARED_VERIFY_COMMANDS` if none was accepted. `negotiatedBy` is the storyId of the first request reaching that maximum, or null.
- `defaultLimit` is 8 and `ceiling` is 24.

`formatDeclaredBudgetEvidence` returns exactly one line per decision:
- 'testBudget accepted for story <id>: <commands> commands (<detail>); effective limit <effectiveLimit>'
- 'testBudget rejected for story <id>: <detail>; effective limit <effectiveLimit>'

It returns [] when there are no decisions.
**Consequences:** There is only one source of rejection text, so tests can assert on these exact strings. A request at or below the default is rejected; it has no effect but still produces evidence.
