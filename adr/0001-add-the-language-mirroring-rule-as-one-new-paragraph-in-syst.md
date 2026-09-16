# ADR-0001: Add the language-mirroring rule as one new paragraph in systemPrompt

**Status:** Accepted
**Context:** The prompt is a single template literal, and each standalone rule is its own paragraph (see :500 and :502). An array of rules or a shared constant would change the structure, which the goal rules out.
**Decision:** In `packages/baro-orchestrator/src/operator/operator-session.ts`, add one new paragraph inside the template literal, right before the closing line "Keep replies short and concrete.", with a blank line on each side. Use exactly this text:
"Language: mirror the language of the person's most recent message in everything addressed to them — answers, questions, progress notes, and the final report. When the person switches language, switch with them. Keep English for code-facing artefacts: commit messages, goal text passed to \`delegate\`, file contents, and identifiers."
Do not change any other line of the prompt or the file.
**Consequences:** The rule text exists only in the prompt. The test checks for substrings of it and does not import a constant.
