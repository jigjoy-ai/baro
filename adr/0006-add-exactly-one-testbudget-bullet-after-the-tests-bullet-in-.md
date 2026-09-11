# ADR-0006: Add exactly one testBudget bullet after the tests bullet in planner-prompts.ts

**Status:** Accepted
**Context:** ADR 0004 says 'Plan shape section'. In the current file, the tests bullet ("Declare story-scoped \"tests\" commands: ...") is the last bullet under RUN SHAPE / Dependency rules, just before the JSON example.
**Decision:** Insert directly after that tests bullet, with the same two-space dash indentation and wrapping:
`  - Optional "testBudget": {"commands": <integer 9-24>, "reason": "<why this story needs more than 8 declared test commands>"} raises the run's declared-test admission limit (default 8, max 24); use it only when necessary.`

The JSON example, the rules list and every other prompt line stay byte-identical.
**Consequences:** Only planner-prompts.ts gets a prompt change. planner-openai-progressive.ts prompt text is untouched.
