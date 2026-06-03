# baro-desktop (Tauri)

The desktop UI for baro — issue #37. A Tauri v2 app (Rust core + React 19 /
Vite / Tailwind v4 / shadcn WebView) that drives the long-lived
**plan → run** session and renders its event stream. The current ratatui TUI
is retired once this reaches parity; the headless engine stays.

## What it does today (F1 vertical slice)

- **Start a run** — enter a goal + target working dir.
- **Plan by chat** — converse with the planner; the **read-only DAG** updates
  live as the plan is split / re-tiered / rewired. Per-story tier badges
  (haiku / sonnet / opus / `backend:model`).
- **RUN gate** — nothing executes until you press **RUN**; then the same shell
  shows live story status, the stderr log, and the final PR link.

It speaks the exact protocol the headless engine emits
(`packages/baro-orchestrator/scripts/session.ts`): the Rust core spawns that
process, forwards its stdout events as Tauri `session-event`s, and writes
`plan_message` / `run_plan` commands back to its stdin.

## Architecture

```
React/shadcn WebView ──invoke(start_session|send_command)──► Rust core (src-tauri/src/lib.rs)
        ▲                                                          │ spawns
        └────────── listen("session-event" / "session-log") ◄──────┴── npx tsx scripts/session.ts
```

- `src/protocol.ts` — typed view of the event stream.
- `src/App.tsx` — the cockpit (chat • read-only DAG • RUN • log).
- `src-tauri/src/lib.rs` — spawn / stream / command bridge.

## Run it

Prereqs (all present on macOS dev machines): Rust, Node, Xcode CLT. The session
shells out to `npx tsx`, resolved from the repo's `node_modules`, so install the
orchestrator deps once at the repo root.

```bash
cd desktop
npm install          # if it hits a root-owned ~/.npm cache, add: --cache /tmp/npm-cache-baro
npm run tauri dev    # launches the app
```

In the app: enter a goal + a target repo path → **Plan it** → refine by chat →
**RUN**. For a mixed-backend run, the session flags are wired through
`start_session` (`tier_map`, `openai_endpoints`, `llm`, `no_git`, `effort`); the
form will expose them next.

## Not yet (follow-ups on #37)

- Direct DAG manipulation (drag / tier dropdown / inline edit) — F3.
- Reuse of kaleidoskop's richer viz components for the live run.
- Run-config form (tier map / endpoints / effort / parallelism).
- Remote / daemon transport (this slice is local stdio via the Rust core).
