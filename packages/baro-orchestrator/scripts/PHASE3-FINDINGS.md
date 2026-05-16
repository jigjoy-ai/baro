# Phase 3 findings — Live Critic + multi-turn StoryAgent

Branch: `mozaik-rework` (merged from `phase3-live-critic`)
Date: 2026-05-03

## Result: architecture works, demo trap doesn't yet differentiate

| Goal | Status |
|---|---|
| Multi-turn StoryAgent (keep stdin open across turns) | ✓ |
| Quiet timer + max-turns budget + hard timeout for termination | ✓ |
| Critic participant evaluates AgentResultItem against acceptance criteria | ✓ |
| CritiqueItem ContextItem published on bus, audit-trailed | ✓ |
| AgentTargetedMessageItem corrective inject (with per-agent emission cap) | ✓ wired |
| Phase-1+2 demos pass unchanged | ✓ |
| Phase-3 demo "treatment" measurably differs from "control" | ✗ trap too weak — see §3 |
| Critic uses Claude CLI subprocess (no `ANTHROPIC_API_KEY` dependency) | ✓ |
| `--with-critic` reaches the Rust `baro` CLI | ✓ |

## Six key findings

### 1. The auth model fragmented when Critic used the Anthropic SDK directly

The original `phase3-live-critic` implementation (autonomous baro run) imported
`@anthropic-ai/sdk` and called `client.messages.create({model:"claude-haiku-4-5"})`.
That made Critic *the only* place in the system that reached for
`process.env.ANTHROPIC_API_KEY` — every other agent went through `claude` CLI
subprocesses and inherited whatever auth the CLI was configured with
(OAuth session, Bedrock, Vertex). Users running Claude Code via OAuth had
no API key in their env, so `--with-critic` ran into "credentials missing"
even though `claude` itself worked fine on the same machine.

**Architectural rule going forward:** all Anthropic model calls in this
package go through the `claude` CLI subprocess. Direct SDK use is reserved
for non-Anthropic providers that have no CLI equivalent. `@anthropic-ai/sdk`
has been removed from the package's dependencies as of commit `a6894f9`.

### 2. The multi-turn refactor *silently* re-routed bus → stdin

Multi-turn StoryAgent (commit `e775370`) moved
`AgentTargetedMessageItem`-forwarding out of `ClaudeCliParticipant.onContextItem`
and into `StoryAgent.onContextItem`. The intent — single owner of stdin
writes to avoid double-delivery — was correct, but it broke
`scripts/demo-single-story.ts`, which uses `ClaudeCliParticipant`
*directly* without any StoryAgent wrapper. The initial bus message landed
in nobody's `onContextItem`, Claude waited on empty stdin, and the
process exited in 1 s with zero events emitted.

Restored `ClaudeCliParticipant.onContextItem` as the canonical owner;
`StoryAgent` now only observes for lifecycle/timing purposes.

### 3. Sonnet 4.6 doesn't fall for the "year 2025" trap any more

The demo prompt asks Claude to write a `LICENSE` containing
`Copyright (c) 2026 Baro Project`. The premise was that Sonnet, trained
in 2025, would hallucinate `2025` on the first turn unless Critic told
it otherwise. In practice, both the control and the treatment runs
produce a correct 2026 license:

```
[phase3] control   (withCritic=false): LICENSE year=2026 found? true
[phase3] treatment (withCritic=true):  LICENSE year=2026 found? true
[phase3] CritiqueItem count (treatment): 1 (verdict=pass)
```

The Critic *infrastructure* works (a CritiqueItem with rich `reasoning`
fields lands in the audit log), but because the control already passes,
the demo doesn't yet show a *differential* between the two runs.

Strengthening the trap is a prompt-engineering task tracked separately.
Candidates: a multi-step constraint embedded in a long reference doc
(easier to miss), a deliberately misleading example block, or a stricter
acceptance criterion that the agent's first-pass output wouldn't satisfy
even if it produced reasonable code.

### 4. Mozaik bus fan-out is fire-and-forget, so observers must drain

`AgenticEnvironment.deliverContextItem` calls
`subscriber.onContextItem(...)` synchronously and ignores the returned
promise. Critic's `onContextItem` spawns a `claude --print --model haiku`
subprocess that takes 5–25 s — so by the time `conductor.run` returns,
the in-flight Critic evaluation is still outstanding and the audit log
hasn't yet seen the CritiqueItem. `phase3-demo` consequently reported
`treatment CritiqueItem count: 0` even when Critic had run.

The fix (commit `a6894f9`):

- `Critic` tracks pending evaluations in a `Set<Promise<void>>`.
- It exposes `idle()` that resolves once every pending eval has emitted.
- `orchestrate()` calls `await critic.idle()` after `conductor.run`
  returns, before running git-stat collection or returning.

The subtle implication: **any Mozaik observer that does async work in
`onContextItem` should expose a similar drain signal**, otherwise tear-down
races destroy its side effects. We may want to canonicalize this in the
framework — e.g. give `Participant` a default `idle()` returning
`Promise.resolve()` and have `AgenticEnvironment.start/stop` await each
subscriber's drain on shutdown.

### 5. Claude `--print --output-format json` is a clean RPC channel

For Critic's evaluation we send a system prompt + user prompt (the
acceptance criteria + the agent's output) and get back JSON:

```json
{ "type": "result", "subtype": "success",
  "result": "{\"verdict\":\"pass\",\"reasoning\":\"…\",\"violated_criteria\":[]}",
  "session_id": "…", … }
```

`result` is the assistant's text response — we re-parse it as the verdict
JSON. Even with strict instructions ("respond ONLY with JSON, no prose,
no markdown fences"), Haiku occasionally wraps the JSON in a fence or
prefaces it with a sentence; `extractVerdictJson` handles both cases via
a balanced-brace scan.

This RPC pattern is **reusable for any Mozaik participant that wants a
small stateless model verdict** — Surgeon (Phase 4) will use the same
shape with a longer system prompt.

### 6. Multi-turn `--print` lifecycle is genuinely subtle

The `e775370` commit introduces three independent termination signals:

- **quiet timer** (default 2 s): closes stdin once Claude has been silent
  for 2 s after its most recent `result` event;
- **max-turns** (default 4): closes stdin once N `result` events have
  fired for this story;
- **hard timeout** (default 300 s): kills the process unconditionally
  for the entire story across attempts.

Edge cases worth knowing about:

- The quiet timer **resets on every `AgentTargetedMessageItem` injection**
  (otherwise Critic could inject feedback right as the timer expires and
  Claude never sees it).
- Single-turn stories work unchanged: result fires, quiet timer expires
  2 s later, stdin closes, Claude exits — no observable difference from
  the old one-shot path beyond the +2 s tail.
- The hard timeout fires across attempts (not per-attempt), to prevent a
  story from looping forever via retries.

## Numbers

Verified end-to-end on `mozaik-rework`:

```
npm run typecheck      ✓
npm run demo:single    ✓  one story, dur=11.7s, cost $0.07
npm run demo:multi     ✓  two stories parallel, dur=9s, cost $0.07
npm run e2e            ✓  real git repo, LICENSE + .gitignore commits
npm run phase2         ✓  Librarian Δ tool calls = 2 (S2: 10 → 8)
npm run phase3         ✓  CritiqueItem count: 1, verdict="pass"

cargo build --bin baro                                      ✓
baro --help | grep -E "with-critic|critic-model|no-…"       4 flags present
```

## Open work

1. **Strengthen the phase3 demo trap** so control + treatment differ.
2. **Document the observer-drain pattern in the Mozaik framework** —
   propose `Participant.idle()` as a first-class concept.
3. **Strip dead Rust code** that Phase 1 obsoleted (`executor.rs`'s
   internal helpers, `claude_runner.rs`'s streaming half, `dag.rs`,
   most of `git.rs`'s mutex helpers) — currently produces 36 dead-code
   warnings on `cargo build`.
4. **Phase 4 Surgeon** can land directly on top of Phase 3's multi-turn
   substrate; the wiring point is a participant that emits new
   `ReplanItem`-s when story failures cluster.
