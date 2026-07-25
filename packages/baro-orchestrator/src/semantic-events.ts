/**
 * SemanticEvent definitions for every baro orchestrator bus event.
 *
 * CONSTRAINT: each event's wire `type` string must stay identical to the
 * pre-migration BusEvent `toJSON().type` — audit-log readers (mozaik-replay
 * legacy adapter, baro's older replay tooling) match on those names.
 * Migration history and per-event wire-format deltas: docs/semantic-events.md.
 *
 * Type discriminators, not `instanceof`: class instances don't survive JSON
 * round-trips (audit log → reload, WebSocket → reload); a `type` check does.
 */

export * from "./events/define.js"
export * from "./events/collaboration.js"
export * from "./events/runtime-graph.js"
export * from "./events/planning.js"
export * from "./events/conversation.js"
export * from "./events/harness-stream.js"
export * from "./events/telemetry.js"
export * from "./events/acceptance.js"
export * from "./events/execution.js"
export * from "./events/market.js"
export * from "./events/integration.js"
export * from "./events/verification.js"
export * from "./events/goal.js"
