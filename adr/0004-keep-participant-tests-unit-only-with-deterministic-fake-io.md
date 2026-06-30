# ADR-0004: Keep participant tests unit-only with deterministic fake IO

**Status:** Accepted
**Context:** Several participants can shell out to `claude`, `codex`, `opencode`, `pi`, `gh`, use OpenAI-backed paths, or trigger memory embedding/vector-store behavior. Live IO would make this suite flaky and credential-dependent.
**Decision:** New participant tests must not call real external LLM CLIs, `gh`, network APIs, OpenAI APIs, ONNX downloads, or the real embedding/vector-store path. CLI participant tests must use temporary executable Node scripts created under `withTempDir(...)` and inject them through existing option fields such as `claudeBin`, `codexBin`, `opencodeBin`, and `piBin`. `Finalizer` tests must use `createPr: false` unless explicitly testing PR command construction with a fake `gh`. `MemoryLibrarian` tests must use `disabled: true` or public-option stubs rather than the real `@baro/memory` embedding flow.
**Consequences:** The participant suite must pass on a clean machine without Claude, Codex, OpenCode, Pi, GitHub CLI, API keys, or network access. Live integration coverage belongs in separate integration scripts, not this participant unit-test extension.
