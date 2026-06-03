# Desktop UI (Tauri) + interactive chat-driven planning

Tracking issue: **#37**. Status: **design / F0–F1 elaboration**. This is the
working spec — edit it as we converge.

---

## 1. Why

baro is, at its core, a **background agent runtime orchestrator**: it plans a
DAG of stories and runs coding agents over it in parallel. Two things follow:

1. The **engine must run headless** — on a laptop, a server, CI, or in the
   background. A UI cannot be a hard dependency.
2. The thing that sells baro — *N agents working a DAG at once* — is exactly
   what a terminal UI cannot show well.

So we split cleanly:

- **Headless `baro` engine** — no UI, streams events, takes commands. The spine.
- **`baro-desktop` (Tauri)** — a *client* of that engine, the rich human UI,
  a genuine alternative to Claude Code / Codex.

The current ratatui TUI is the awkward middle (a terminal GUI that is neither
headless nor rich). It gets **retired** once the desktop app reaches parity —
**last**, not first.

## 2. Architecture

```
        ┌──────────────── baro-desktop (Tauri) ─────────────────┐
        │  Rust core  ──spawn/bridge──►  headless `baro`         │
        │     ▲  BaroEvent (stdio / localhost WS)                │
        │     │  BaroCommand ──────────►                         │
        │  WebView (React 19 + Tailwind v4 + Vite)               │
        │     · kaleidoskop viz components (DAG, story, tokens)  │
        │     · shadcn/ui chrome (chat, dialogs, config, palette)│
        └────────────────────────────────────────────────────────┘
                 one engine — TUI (until retired) + desktop are siblings
```

- **Contract** = the existing `BaroEvent` / `BaroCommand` protocol
  (`packages/baro-orchestrator/src/tui-protocol.ts`). The desktop app is just
  another consumer of the same stream the TUI consumes today.
- **Local-first.** Events over stdio or a localhost WebSocket; commands back the
  same way. Remote/daemon + "watch from anywhere" is a **later, secondary**
  path (see §7) — explicitly out of scope for the first milestone.
- **Retire the TUI = subtract ratatui, keep the glue.** The `baro-tui` crate
  keeps `planner_runner`, `architect_runner`, `git`, `orchestrator_client`,
  `discovery`, `doctor`, `executor`, resume. Only `app.rs` rendering / widgets /
  key handling go away. Headless `baro` = that glue + clean JSON/log output
  (the node `cli.ts` already does most of this).

## 3. The centerpiece: interactive planning before execution

Today: `goal → one-shot Planner → prd.json → autonomous run`.

New lifecycle:

```
goal ─► PLAN (chat ⇄ DAG, cost/time estimate) ─► ⟦RUN gate⟧ ─► EXECUTE (steer + monitor) ─► PR
```

In **PLAN** mode you converse with the planner to shape the DAG —
split / merge / add / remove / rewire stories, set per-story tier, bulk re-tier
("cheap ones on minimax"), set routing / effort / parallelism. **Nothing runs**
(no agents, no git, only planner tokens) until **RUN**. This is what makes baro
*chat-to-shape-a-swarm* instead of *chat-to-one-agent*.

In **EXECUTE** mode the same chat column becomes a steering surface: it narrates
progress and lets you `redirect` a message to a live story (the command already
exists in the protocol).

### F1 sketch (chat-only edits, read-only DAG)

```
┌ baro · new run ───────────────── claude:opus planner · $0.01 ───┐
│ goal ▸ Add a reservations module to MenuService                  │
├─ PLAN CHAT ────────────────────┬─ DAG (read-only preview) ───────┤
│ you ▸ split the service story  │  L0  S1 Entity            opus  │
│ baro ▸ S4 → S4a (CRUD, sonnet) │  L1  S2 DTOs   S3 Migrate haiku │
│   + S4b (overlap+cap, opus)    │  L2  S4a Svc   S4b Overlap      │
│ you ▸ cheap ones on minimax    │  L3  S5 Build  S6 Mapper        │
│ ▸ message planner…          ⏎  │  L4  S7 Controller + wiring     │
├────────────────────────────────┴─────────────────────────────────┤
│              [ ▶ RUN THIS PLAN ]   ~8 stories · ~$0.05            │
└───────────────────────────────────────────────────────────────────┘
```

## 4. Why this is elegant with Mozaik

The conversational planner is a new **Mozaik participant**, mirroring the
existing Architect / Planner / Surgeon:

- holds a `ModelContext` = chat history + the **draft PRD**,
- exposes **DAG-mutation tools**, and emits draft-PRD updates as semantic
  events on the bus,
- the desktop UI subscribes to those events to re-render the draft DAG, and
  sends user turns + the final RUN as commands.

**Key reuse:** the edit vocabulary — split / prereq / rewire / add / remove —
**already exists in the Surgeon** (`participants/surgeon.ts`, applied in
`conductor.ts`). The interactive planner is *"Surgeon, driven by the user,
before the run."* We are not inventing DAG mutation; we are exposing it
conversationally and gating it behind RUN.

## 5. UI reuse

- **kaleidoskop** (`~/Desktop/kaleidoskop-claude`, React 19 + Tailwind v4 +
  Vite 8) already has a **live WS source mode** and DAG/story/token viz. Reuse
  its components as a frontend package, pointed at the **local** engine. We do
  **not** depend on the hosted instance to render (that inverts the data flow
  and cannot send control commands back).
- **shadcn/ui** for chrome (chat, `Dialog`/`Sheet`, config forms for
  tier-map / endpoints / effort, `Command` palette, toasts). Runs fine in the
  Tauri WebView. The bespoke DAG graph stays custom (canvas / reactflow).
  kaleidoskop's stack is already the modern shadcn target (`shadcn@latest`,
  Tailwind v4 CSS-first, React 19).

## 6. Phased plan

| Phase | Deliverable |
| --- | --- |
| **F0** | Headless `baro` streams the **full** event stream (incl. planning); local bridge (stdio / localhost WS). No new UI. |
| **F1** | **Chat planning + read-only DAG + RUN gate.** Conversational planner (Mozaik participant) + draft PRD. First real milestone. |
| **F2** | Live execution cockpit: DAG monitor, per-story logs, token/cost, `redirect`. |
| **F3** | Direct manipulation: drag nodes, tier dropdown, inline edit, add/delete — UI over the same mutation ops. |
| **F4** | Retire the ratatui TUI once Tauri reaches parity. |

**This issue's milestone = F0 + F1.** The hard, novel work is the backend
(conversational planner + draft mutation + RUN gate); the F1 UI stays trivial,
which is precisely why it goes first.

## 7. Out of scope (this milestone)

Remote / daemon mode; hosted "watch from anywhere"; live-ingest on kaleidoskop;
drag-n-drop; deleting the TUI.

## 8. Open questions

- **Transport:** stdio vs localhost WS for F0. Lean WS (kaleidoskop already
  speaks it; smooths the later remote path).
- **Planning events gap:** does headless already emit Architect/Planner progress
  as protocol events, or only render them in the TUI? (Resolve in F0.)
- **Draft-PRD shape:** reuse `PrdFile`/`PrdStory` verbatim as the draft, plus a
  conversation transcript alongside.
- **RUN-gate invariant:** PLAN is strictly dry — zero git/agents/cost beyond
  planner tokens. Confirm as a hard rule.
- **Protocol extension:** new `BaroEvent`s (`plan_draft`, `plan_message`) and
  `BaroCommand`s (`plan_message`, `run_plan`) — design alongside F0.

## 9. First concrete steps

1. F0 audit: trace whether Architect/Planner progress already reaches the
   `BaroEvent` stream; list the gaps.
2. Spike the conversational planner as a Mozaik participant over the existing
   PRD-mutation ops (no UI) — drive it from a script, assert the draft DAG
   mutates coherently across turns.
3. Define the protocol extension (`plan_draft` / `plan_message` / `run_plan`).
4. Stand up the Tauri shell + kaleidoskop viz + shadcn chat against a mocked
   draft stream, then wire to the real engine.
