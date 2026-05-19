# Changelog

A concise list of every published version. For full release notes, see the corresponding commit on the v* tag.

## v0.40.0 — chore(0.40.0): remove `--share-architect-cache` experimental flag after empirical A/B showed no cache savings — flag was added in 0.39.0 on the hypothesis that routing the Architect's DecisionDocument through Claude Code's `--append-system-prompt` (cached system-prompt prefix) instead of the per-story user prompt would let stories 2..N read the DD from Anthropic's prompt cache at the 10× discount; A/B test on the same JSDoc-generation goal (6 stories, `--parallel 2`) showed Run B (flag on) had **+11% cache_creation_input_tokens** vs Run A (flag off) — 234,061 → 259,276 — and total estimated cost was **+16%** ($2.19 → $2.55), with the per-story breakdown confirming every story still paid its own ~30-80K cache_creation regardless of whether the DD lived in the system prompt or the user prompt; Anthropic's prompt cache appears to be per-Claude-Code-subprocess-conversation in practice, not org-scoped at the level the experiment assumed (audit logs `~/.baro/runs/MenuServiceCacheTest{A,B}-1779213820/1779214446.jsonl` from 2026-05-19 are the receipts); flag and all 11-file plumbing reverted; the existing prompt-shape (DD prepended to user prompt) is the cheapest configuration for now, kept as default
## v0.39.1 — docs(0.39.1): README rewritten for conversion — leads with the parallel-agents + no-central-coordinator story instead of a feature list, two Mermaid diagrams (typical coordinator-in-the-middle orchestrator vs baro on Mozaik's shared event bus, and the actual run flow Goal → Architect → Planner → N parallel Story Agents → Finalizer → PR), TUI mid-run screenshot promoted to the primary hero image (replacing the brand wordmark, which moves to `assets/screenshot-wordmark.png`) so visitors landing from daily.dev see real product output inside 30 seconds; "What's new" version dumps and the long `--options` table moved to docs.baro.rs (CHANGELOG.md keeps the per-version detail); npm package and GitHub README now in sync (npm only re-syncs on tag push, so v0.39.0 still served the older modernized-but-verbose copy)
## v0.39.0 — feat(0.39.0): `--share-architect-cache` (experimental) — opt-in CLI flag that routes the Architect's DecisionDocument through Claude Code's `--append-system-prompt` instead of prepending it to each story's user prompt; because Anthropic's prompt cache hashes the system prompt + tools as the cache key but excludes user messages, with the flag on stories 2..N read the DD from cache at the 10× discount instead of each re-paying its own `cache_creation` (~5-10K tokens × N stories); default OFF — existing prompt-shape contract preserved; plumbed end-to-end through 11 files (Rust `Cli` → `app` → `ExecutorConfig` → `OrchestratorConfig` → `build_command`; TS `cli.ts` → `OrchestrateConfig` → `Conductor.resolvePrompt` split → `StorySpawnRequestItem.appendSystemPrompt` → `StoryFactory` → `StorySpec` → `StoryAgent` → `ClaudeCliParticipant` buildArgs → spawned `claude --append-system-prompt <DD>`); measure with audit-log `cache_creation_input_tokens` totals across stories before flipping default
## v0.38.2 — fix(0.38.2): Execute dashboard showed 0/N and all stories as Pending on resume — `BaroEvent::Init` hard-coded `StoryStatus::Pending` for every story regardless of the `completed` flag already loaded into `app.review_stories` from `prd.json`, so a 22/33 resume rendered as `0/33` with every prior-run finish drawn as `○` instead of `✓`; the orchestrator does not replay `StoryComplete` for stories that finished in earlier sessions (the stale `// Init only sends incomplete stories` comment notwithstanding — Init now sends every story), so the only correct moment to seed those statuses is at Init; the handler now consults `review_stories` and starts each story as `Complete` when its prd.json `passes` flag was true (fresh runs are unaffected because `review_stories` is empty there)
## v0.38.1 — fix(0.38.1): Enter key dropped on Ghostty / kitty-keyboard-protocol terminals — Resume Review (and Plan Review, Welcome, ApiKeyInput, ProviderPicker, refine overlay) hung waiting for confirmation because the main event loop filtered out non-`Press` `KeyEventKind`s, but Ghostty (and other kitty-proto-enabled terminals) deliver Enter as a Release-only event or as a literal `Char('\r')`/`Char('\n')` — Enter-like keys now bypass the Press-only filter and the five Enter match arms accept `Enter | Char('\r') | Char('\n')`; `q` was unaffected because terminals send letter keys via the legacy path
## v0.38.0 — feat(0.38.0): `--llm openai` defaults bumped — Architect/Planner/Surgeon/StoryAgent all on `gpt-5.5` (Planner/Surgeon were 5.4); Critic stays on `gpt-5.4-mini` because per-turn structured PASS/FAIL verdicts don't justify the cost bump on the highest-volume call in a run; fix CLI-goal + `--llm openai` path that skipped the API-key entry screen AND the env pre-read (`baro --llm openai "$(cat GOAL.md)"` crashed with "OPENAI_API_KEY is not set" when the user had typed the key via TUI on a prior run but not into their shell env) — env is now pre-read in both paths, and the missing-key case detours through ApiKeyInput → planning instead of through Welcome
## v0.37.1 — fix(0.37.1): UTF-8 panic in goal-truncation — byte-index slice `&goal[..39]` panicked when an em-dash or other multi-byte char crossed offset 39 (planning + context screens); switched to `chars().take(39)`
## v0.37.0 — release(0.37.0): branch-per-run isolation (every fresh run creates a new suffixed `baro/<slug>-<unix-mod-100k>` branch, never falls back to checkout — side-by-side runs from sibling clones sharing an `origin` can't collide on `git push`); suffixed slug persisted back to `prd.json` for resume + Finalizer; planner prompt gains explicit PARALLELISM block calling out the linear-chain anti-pattern (observed in Mozaik run that emitted `S1 → S2 → S3 → S4 → S5` with no symbol-level reason); `[orchestrate]` banner on `--llm openai` now truthfully says all five phases route through Mozaik's native OpenAI runner
## v0.36.3 — fix(0.36.3): llm-aware routed model defaults — `--llm openai` no longer passes Claude's "opus" to the OpenAI planner ("unknown model" crash); TUI planning header reads from `app.llm` so OpenAI runs sit under "OpenAI" instead of "Claude"
## v0.36.2 — fix(0.36.2): two production-bundle bugs — stripped duplicate shebang from `run-architect.mjs` / `run-planner.mjs` (was double-shebang from tsup banner + source-side `#!/usr/bin/env tsx`); made `OpenAIResponses` construction lazy so loading the bundle no longer requires `OPENAI_API_KEY` even on the Claude path
## v0.36.1 — fix(0.36.1): production install — Architect/Planner subprocess discovery now finds bundled `run-architect.mjs` / `run-planner.mjs` next to the binary (matches the orchestrator's existing `cli.mjs` path); fixes "Planning failed: could not locate baro repo" when baro is installed via npm and run outside a dev checkout
## v0.36.0 — feat(0.36.0): commit + PR co-author trailer attributing every baro-run commit to the @baro-rs GitHub account
## v0.35.0 — feat(0.35.0): OpenAI telemetry — switch to Mozaik's OpenAIResponses (ModelRuntime layer) so each round's TokenUsage surfaces in stderr summaries and in AgentResultItem.usage on the bus
## v0.34.0 — feat(0.34.0): rename ClaudeResultItem → AgentResultItem (provider-agnostic); new --architect-model / --planner-model / --story-model per-phase override flags
## v0.33.0 — feat(0.33.0): OpenAIStoryAgent — full Mozaik-native coding loop (Phase 6, final); `--llm openai` is now end-to-end OpenAI and the flag is unhidden from `--help`
## v0.32.0 — feat(0.32.0): Planner moves Rust → TS with OpenAI sibling (Phase 5); main.rs drops below 1300 LoC for the first time
## v0.31.0 — feat(0.31.0): Architect moves Rust → TS with OpenAI sibling (Phase 4); welcome flow now picks Claude vs Mozaik-native OpenAI with in-memory API-key entry
## v0.30.1 — fix(0.30.1): postinstall.js downloads from jigjoy-ai/baro (was stale Lotus015/baro after org transfer; postinstall failed silently → "binary not installed")
## v0.30.0 — feat(0.30.0): CriticOpenAI + SurgeonOpenAI siblings (Phase 3 of dual-mode); --llm openai now routes verdict + replan reasoning through Mozaik's native OpenAI runner
## v0.29.0 — feat(0.29.0): --llm claude|openai flag plumbed end-to-end (Phase 2 of dual-mode); hidden, no behaviour change yet
## v0.28.0 — refactor(0.28.0): Mozaik 3.6.5 → 3.9.3 upgrade with BaroEnvironment/BusEvent adapter (Phase 1 of dual-mode native OpenAI support)
## v0.27.0 — chore(0.27.0): repository moved to jigjoy-ai/baro + fix broken screenshot on npm
## v0.26.0 — feat(0.26.0): scope discipline + planner/architect triage + `--quick` fast path
## v0.25.1 — fix(debuggability): baro --doctor, persisted planner logs, real error UI (#17)
## v0.25.0 — release(0.25.0): Architect phase — one mind decides, many hands execute
## v0.24.0 — release(0.24.0): Librarian mid-flight broadcasts + intra-level stagger
## v0.23.6 — release(0.23.6): pin @mozaik-ai/core to 3.6.5
## v0.23.5 — release(0.23.5): CHANGELOG.md + `baro --help` issues/twitter footer
## v0.23.4 — release(0.23.4): docs cheat sheets + --version flag + Finalizer crash fix
## v0.23.3 — release(0.23.3): Finalizer — opens the PR at the end of a run
## v0.23.2 — release(0.23.2): real-world-test bug bash
## v0.23.1 — release(0.23.1): refresh README
## v0.23.0 — release(0.23.0): default exec = opus, smaller-stories planner, branch dedup, terminal-clear on tab switch
## v0.22.5 — release(0.22.5): move default audit log to ~/.baro/runs (survives project-dir resets)
## v0.22.4 — release(0.22.4): bulletproof audit dir + stderr sidecar pre-touch
## v0.22.3 — release(0.22.3): disable hard-timeout default — real work needs more than 5 minutes
## v0.22.2 — release(0.22.2): persist orchestrator stderr + DAG event + completion-screen counter
## v0.22.1 — release(0.22.1): propagate run success+abortReason to TUI
## v0.22.0 — release(0.22.0): TUI overall-progress counter + abnormal-exit banner + always-on audit log
## v0.21.0 — release(0.21.0): never silently drop work — Surgeon-replan-by-default + honest success
## v0.20.0 — release(0.20.0): bump versions + refresh README architecture + replan cleanup
## v0.18.1 — fix: v0.18.1 - sync README to npm package, auto-copy in CI
## v0.18.0 — feat: v0.18.0 - dry-run mode
## v0.17.1 — chore: v0.17.1 - include updated README in npm publish
## v0.17.0 — feat: v0.17.0 - interactive settings on welcome screen, .barorc config
## v0.16.0 — feat: v0.16.0 - header redesign, dynamic completion box, arrow scroll
## v0.15.0 — feat: v0.15.0 - log scrolling, PR push fix, remove highlight
## v0.14.0 — feat: v0.14.0 - notification module, remove objc2 dependency
## v0.13.0 — feat: v0.13.0 - TUI scrolling, session lock, branch safety, file stats fix
## v0.12.0 — feat: v0.12.0 - refactor and bugfixes
## v0.11.1 — fix: v0.11.1 - store binary in ~/.baro/bin to fix npm upgrade
## v0.11.0 — feat: v0.11.0 - live token counter on execute dashboard
## v0.10.3 — fix: v0.10.3 - resolve symlinks in shell wrapper
## v0.10.2 — fix: v0.10.2 - fix ENOTEMPTY on npm upgrade, show time saved in PR
## v0.10.1 — fix: v0.10.1 - show time saved in PR description
## v0.10.0 — feat: v0.10.0 - automatic context builder (CLAUDE.md generation)
## v0.9.2 — fix: v0.9.2 - dynamic version display from Cargo.toml
## v0.9.1 — fix: v0.9.1 - fix Windows build, enforce build verification in story prompt
## v0.9.0 — feat: v0.9.0 - Windows support, fix time saved calculation
## v0.8.6 — chore: v0.8.6 - repo cleanup, gitignore, branch pruning
## v0.8.5 — fix: v0.8.5 - notification fires immediately on completion, not on quit
## v0.8.4 — chore: v0.8.4 - add made by Lotus/JigJoy to README
## v0.8.3 — fix: v0.8.3 - fix token usage parsing from Claude stream-json
## v0.8.2 — fix: v0.8.2 - zombie tabs, scrollback, review logs, time saved, notification
## v0.8.1 — feat: v0.8.1 - token tracking, notification fix
## v0.8.0 — feat: v0.8.0 - model routing, updated README
## v0.7.5 — fix: v0.7.5 - speedup calculation floor at 1.0x, skip for single story
## v0.7.4 — chore: bump to v0.7.4 (v0.7.3 npm publish failed due to version mismatch)
## v0.7.3 — chore: update prd.json completion status
## v0.7.2 — feat: v0.7.2 - rich PR body with stories table, stats, and time saved
## v0.7.1 — feat: v0.7.1 - plan refinement overlay on review screen
## v0.7.0 — feat: v0.7.0 - configurable parallelism and story timeout
## v0.6.1 — feat: v0.6.1 - time saved metric with parallel speedup display
## v0.6.0 — feat: v0.6.0 - finalize with PR creation, updated README with screenshot
## v0.5.3 — feat: v0.5.3 - review agent with build detection and code quality checks
## v0.5.2 — fix: stricter but focused review agent, retry on planning fail, cleanup
## v0.5.1 — feat: v0.5.1 - branch per execution, resume interrupted runs
## v0.5.0 — feat: v0.5.0 - review agent between DAG levels
## v0.4.5 — fix: make git pull/push best-effort, never skip stories on git errors
## v0.4.4 — chore: bump to v0.4.4 - codebase refactor and dead code cleanup
## v0.4.3 — chore: bump to v0.4.3 - git coordination for parallel execution
## v0.4.2 — chore: bump to v0.4.2 - cleanup legacy TS, fix scroll bugs
## v0.4.1 — chore: bump to v0.4.1 - auto-push after story commits
## v0.4.0 — chore: bump to v0.4.0 - TUI visual overhaul
## v0.3.10 — fix(tui): use fixed light cyan for active planner, no color cycling
## v0.3.9 — feat(tui): giant 9-row logo, tall input, blinking C64 block cursor
## v0.3.8 — fix(tui): use ANSI colors instead of RGB for Terminal.app compatibility
## v0.3.7 — fix(tui): fix rainbow animation - use owned strings per letter span
## v0.3.6 — feat(tui): C64-style welcome screen with massive rainbow logo
## v0.3.5 — fix: include placeholder bin/baro in npm package for symlink creation
## v0.3.4 — fix: don't bundle any binary in npm package, always download on install
## v0.3.3 — fix: resolve symlinks in bin wrapper for global npm install
## v0.3.2 — fix: use shell wrapper for bin entry, download native binary on install
## v0.3.1 — chore: bump to v0.3.1
## v0.3.0 — chore: add README and bump to v0.3.0
## v0.2.0 — chore: bump to v0.2.0
## v0.1.1 — chore: bump to v0.1.1
## v0.1.0 — fix: use macos-15 runner (macos-13 deprecated)
