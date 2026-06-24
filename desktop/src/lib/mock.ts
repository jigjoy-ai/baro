// A self-contained demo run. The "Replay demo" button streams these events
// through the exact same `onEvent` reducer the live Tauri `session-event`
// stream uses — so the UI never special-cases the source. Timings are in ms
// from the start of the replay.

import type { SessionEvent } from "@/protocol"

export const MOCK_GOAL = "Add a reservations module to the booking service"

const STORIES = [
    { id: "S1", title: "Scaffold reservation data model", depends_on: [] as string[], model: "sonnet" },
    { id: "S2", title: "Add reservation API endpoints", depends_on: ["S1"], model: "sonnet" },
    { id: "S3", title: "Wire reservations into the booking flow", depends_on: ["S1"], model: "opus" },
    { id: "S4", title: "Tests + docs for reservations", depends_on: ["S2", "S3"], model: "haiku" },
]

const LEVELS = [
    [{ id: "S1", model: "sonnet" }],
    [{ id: "S2", model: "sonnet" }, { id: "S3", model: "opus" }],
    [{ id: "S4", model: "haiku" }],
]

export const MOCK_RUN: { at: number; evt: SessionEvent }[] = [
    { at: 0, evt: { type: "plan_status", state: "planning", model: "sonnet" } },
    { at: 500, evt: { type: "plan_reply", text: "Reading the repo and the existing booking service…" } },
    { at: 1500, evt: { type: "plan_reply", text: "I'll split this into four stories across three dependency levels." } },
    {
        at: 1900,
        evt: {
            type: "plan_draft",
            project: "booking-service",
            description: MOCK_GOAL,
            stories: STORIES,
            levels: LEVELS,
        },
    },
    { at: 2200, evt: { type: "plan_status", state: "idle" } },
    { at: 2500, evt: { type: "plan_reply", text: "Here's the plan. Hit ▶ RUN to execute, or tell me what to change." } },

    // user "runs" the plan (auto-driven in the demo)
    { at: 3600, evt: { type: "plan_committed", prd: "reservations.md" } },
    { at: 3900, evt: { type: "dag", levels: [[{ id: "S1" }], [{ id: "S2" }, { id: "S3" }], [{ id: "S4" }]] } },

    // level 0
    { at: 4200, evt: { type: "story_start", id: "S1", title: STORIES[0].title } },
    { at: 4500, evt: { type: "story_log", id: "S1", line: "reading src/models/index.ts" } },
    { at: 5000, evt: { type: "token_usage", id: "S1", input_tokens: 4200, output_tokens: 1300 } },
    { at: 5300, evt: { type: "story_log", id: "S1", line: "[tool] write src/models/reservation.ts" } },
    { at: 6100, evt: { type: "story_complete", id: "S1", duration_secs: 19, files_created: 2, files_modified: 1 } },
    { at: 6200, evt: { type: "progress", completed: 1, total: 4, percentage: 25 } },

    // level 1 (parallel)
    { at: 6400, evt: { type: "story_start", id: "S2", title: STORIES[1].title } },
    { at: 6500, evt: { type: "story_start", id: "S3", title: STORIES[2].title } },
    { at: 6900, evt: { type: "story_log", id: "S2", line: "[tool] write src/routes/reservations.ts" } },
    { at: 7200, evt: { type: "story_log", id: "S3", line: "patching src/booking/flow.ts" } },
    { at: 7700, evt: { type: "token_usage", id: "S2", input_tokens: 5100, output_tokens: 2100 } },
    { at: 8300, evt: { type: "story_log", id: "S2", line: "[tool] write src/controllers/reservation.ts" } },
    { at: 8900, evt: { type: "story_complete", id: "S2", duration_secs: 25, files_created: 2, files_modified: 0 } },
    { at: 9000, evt: { type: "progress", completed: 2, total: 4, percentage: 50 } },
    { at: 9300, evt: { type: "token_usage", id: "S3", input_tokens: 6800, output_tokens: 2600 } },
    { at: 9400, evt: { type: "story_log", id: "S3", line: "resolving merge into booking/flow.ts" } },
    { at: 10000, evt: { type: "story_complete", id: "S3", duration_secs: 35, files_created: 0, files_modified: 3 } },
    { at: 10100, evt: { type: "progress", completed: 3, total: 4, percentage: 75 } },

    // level 2
    { at: 10400, evt: { type: "story_start", id: "S4", title: STORIES[3].title } },
    { at: 10700, evt: { type: "story_log", id: "S4", line: "[tool] write tests/reservation.test.ts" } },
    { at: 11300, evt: { type: "token_usage", id: "S4", input_tokens: 3200, output_tokens: 1500 } },
    { at: 11700, evt: { type: "story_log", id: "S4", line: "updating docs/reservations.md" } },
    { at: 12300, evt: { type: "story_complete", id: "S4", duration_secs: 18, files_created: 2, files_modified: 1 } },
    { at: 12400, evt: { type: "progress", completed: 4, total: 4, percentage: 100 } },

    // finalize
    { at: 12600, evt: { type: "finalize_start" } },
    { at: 13300, evt: { type: "finalize_complete", pr_url: "https://github.com/jigjoy-ai/booking-service/pull/128" } },
    { at: 13700, evt: { type: "done", total_time_secs: 96, success: true } },
]

export const MOCK_DURATION = Math.max(...MOCK_RUN.map((m) => m.at)) + 400
