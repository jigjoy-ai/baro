# Mid-run adaptive intervention (the "Supervisor") — design plan

## The insight: most of this already exists — it just fires too late

baro already has the hard parts of adaptive DAG surgery. The gap is *timing*, not capability.

| Capability | Status | Where |
|---|---|---|
| Mozaik bus + observers (`BaseObserver`, `deliverSemanticEvent`, `onExternalEvent`) | ✅ exists | `@mozaik-ai/core` |
| Live per-story signals on the bus: `AgentState` (phase), `token_usage`/`token_progress`, `activity` (tool_call/result/agent_msg), `StoryResult` | ✅ exists | `semantic-events.ts` |
| **Dynamic DAG** — `buildDag` recomputed each level from the PRD | ✅ exists | `dag.ts`, `conductor.ts` |
| **Replan primitive** — `Replan{addedStories, removedStoryIds, modifiedDeps}` buffered → applied at level boundary → next `buildDag` picks it up | ✅ exists | `semantic-events.ts`, `conductor.ts:273,557` |
| **Split + model escalation logic** — the Surgeon's system prompt already prefers "split into 2-3 smaller stories" and "bump tier UP one step (haiku→sonnet→opus)" | ✅ exists | `surgeon.ts` (SURGEON_SYSTEM_PROMPT) |
| End-of-run recovery attempts | ✅ exists | `conductor.ts` (`recoveryAttempts`) |
| **LIVE detection of a stall + EARLY intervention (before the retry budget burns)** | ❌ **missing** | — this is what we build |

**Why Giorgos's run failed anyway:** the Surgeon only reacts to a *terminal* `StoryResult(success=false)` — i.e. **after** a story exhausts all retries. S11 burned 3 non-terminal attempts (~30 min, 1M+ input tokens) which consumed the whole run budget; the control-plane watchdog (`timeoutSecs+120`) then killed the run as "no result" **before** the Surgeon's split could be produced/applied. The intelligence existed; it never got a turn.

---

## The design: a live `Supervisor` observer that trips the existing escalation ladder *early*

Add one new Mozaik observer that watches in-flight stories and intervenes *before* the budget is gone — reusing the Surgeon + Replan machinery instead of rebuilding it.

### 1. Detection (`Supervisor extends BaseObserver`)
Per in-flight story, accumulate live signals from the bus (all already emitted):
- **Token burn** — cumulative in+out from `token_usage`/`token_progress`. Trip if > a per-story budget (e.g. 400k in — well under S11's 1M).
- **Wall-clock** — time in the current attempt vs a soft cap (e.g. 60% of `storyTimeoutSecs`), so we act before the hard timeout.
- **Non-terminal churn** — count of "did not reach a terminal state" retries (from the story-agent loop).
- **No-progress heuristics from `activity`** (the S11 signature):
  - N consecutive tool calls with **no `file_change`** (pure read/grep exploration, not converging).
  - **Repeated near-identical tool calls** (re-reading the same file, repeated greps).
  - High "let me reconsider / rethink" `agent_msg` ratio.
- Combine → a **stall score**; trip when it crosses a threshold. (Start with simple token+wallclock+no-file-change; add loop-detection later.)

### 2. Intervention ladder (escalating, tracked per story)
When a stall trips, act in cheap→expensive order:
1. **Escalate model/effort** (fast, cheap): abort the current attempt and re-run the *same* story on a stronger model / higher effort (sonnet→opus, or bump `--effort`). Short-circuits the wasteful same-tier retries. Mechanically = a `Replan` that removes the story and re-adds it with a bumped `model` tier (exactly the Surgeon's "rewire/prereq → bump tier up one step", but triggered live instead of post-mortem).
2. **Split / decompose**: if escalation still stalls, or the story is obviously too broad (huge token burn, many files touched), trigger the Surgeon's **split** early — emit a `Replan` that removes the stuck story and adds 2-3 smaller sub-stories. Conductor applies at the level boundary → the smaller stories run and converge. (We can literally reuse `Surgeon.evaluateWithLlm` by feeding it a *live-stall* pseudo-failure instead of only a terminal one.)
3. **Graceful skip → partial**: last resort — deterministic skip (remove the story) so the rest finalizes and a **partial PR** still ships.

### 3. Wiring (Mozaik-native, mirrors Critic/Surgeon)
- `Supervisor` joins the `AgenticEnvironment` like the Critic/Surgeon; `onExternalEvent` consumes `AgentState` / `token_usage` / `activity` (read-only).
- To act on a *running* story it emits a bus event; two clean options:
  - **Reuse `Replan`** for escalate (remove+re-add higher tier) and split (remove+add sub-stories) — already wired end-to-end.
  - Add a tiny `StoryIntervention{storyId, action, reason}` event **only if** we need to abort a still-running attempt mid-level. The Conductor already exposes `storyAgents` for abort; on intervention it aborts the stuck attempt so the level can close, then the buffered `Replan` applies at the boundary.
- Net new code = the `Supervisor` observer + a small abort hook. Everything downstream (Replan → Conductor → buildDag → escalated/split stories) is untouched.

### 4. Prerequisite: decouple the timeouts (else the intervention never gets a turn)
This is the Phase-1 fix and it's load-bearing for the adaptive layer:
- **Separate per-story vs per-run budgets** — the control plane currently sends ONE `timeoutSecs` (default 1800) used as both the per-story CLI cap AND the run watchdog base (`timeoutSecs+120`). A single stuck story eats the whole run. Send a smaller per-story cap (e.g. 15 min) + a larger run budget (e.g. 45–60 min).
- **Idle-based run watchdog** — reset the control-plane watchdog on each received event, so an actively-emitting run (even a looping one) isn't blunt-killed. The Supervisor becomes the *intelligent* cap; the watchdog only catches a truly silent/dead runner.
- **Supervisor token/wall-clock cut-off** replaces the "burn 3 full retries then time out" path with an early, surgical escalate/split.

---

## Why this architecture is right
- **Leverages proven pieces** (Surgeon split+escalate prompt, Replan→dynamic DAG, level-boundary application). We're not inventing DAG surgery — it's shipped and tested.
- **Fills exactly one gap**: live detection + early intervention. Small, contained new surface (`Supervisor` + abort hook).
- **Mozaik-native**: observer + semantic events, identical pattern to Critic/Surgeon → consistent, testable in isolation.
- **Turns a blunt timeout-kill into an adaptive ladder**: escalate model → split into sub-stories → graceful degrade → partial PR. This is the moat: a run that *heals itself* mid-flight instead of dying at the wall.

## Phased delivery
- **P0 (unblocks everything):** decouple timeouts + idle watchdog + partial-PR-on-failure (so today's runs stop dying with "no result", and the Surgeon that already exists gets a chance to fire on real terminal failures).
- **P1 (the adaptive layer):** `Supervisor` observer with token + wall-clock + no-file-change detection → **escalate** ladder step (reuse Replan/tier-bump).
- **P2:** add **split** step (reuse Surgeon.evaluateWithLlm on a live stall) + loop/repeat-tool detection.
- **P3:** tuning — stall thresholds, per-tier budgets, telemetry (emit `activity`/decision events so the TUI + dashboard show "Supervisor escalated S11 → opus" / "split S11 into S11a/S11b").

## Open design questions
- Abort-mid-level vs let-attempt-finish: aborting is snappier but needs the Conductor abort hook; letting it finish then replanning is simpler but wastes the tail of one attempt. Lean: abort on token/wall-clock breach, let-finish on soft loop signals.
- Escalation cost guard: escalating to opus mid-run raises $/run — cap escalations per run (like `maxReplans`) and prefer split (smaller pieces) over "same scope, bigger model" when token burn is the signal.
- Detection false-positives: a legitimately long, converging story (lots of file_changes, steady progress) must NOT trip. Weight the score toward *no-progress* signals, not raw duration.
