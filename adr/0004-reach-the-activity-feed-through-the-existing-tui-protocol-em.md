# ADR-0004: Reach the activity feed through the existing tui-protocol emit, injectable via CriticEvidenceSource

**Status:** Accepted
**Context:** Scouting found no emitter on the critic path: the only activity mechanism in the repo is the module-level free function emit from src/tui-protocol.ts:223, which the four execution/forwarders obtain by plain import (coordination.ts:25 etc.). Routing through a new semantic event type and a forwarder change would be a new mechanism and would touch files outside the story; rejected. A bare module import alone would make the wiring untestable without stdout capture, so the same function is exposed as an optional injection point defaulting to it.
**Decision:** Import the existing emitter in critic-evidence.ts: `import { emit } from "../tui-protocol.js";`. Extend the existing `CriticEvidenceSource` interface (critic-evidence.ts:59-97) with ONE new optional member, declared last:

`readonly emitActivity?: (event: { type: "activity"; id: string; kind: string; text: string }) => void;`

Resolve it at the emission site as `const emitActivity = source?.emitActivity ?? emit;`. Do NOT create a new emitter module, class, interface, event bus, or SemanticEvent type; do NOT modify src/tui-protocol.ts, src/execution/forwarders/*, or src/orchestrate.ts; do NOT add the field to any other interface. The `kind` value is the literal string "warn" and the id field is `id` — no new kind literal is introduced.
**Consequences:** Production keeps the existing single emit path (stdout NDJSON) with no wiring changes anywhere else; tests inject a spy. src/acceptance now imports src/tui-protocol.ts — this is a leaf protocol module (types + emit) so no import cycle is created; implementers must confirm `npm run -w packages/baro-orchestrator typecheck` stays clean.
