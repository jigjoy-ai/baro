# ADR-0005: Story writes list and verification perimeter

**Status:** Accepted
**Context:** The run declares disjoint writes and per-story verification; repo-wide test commands are rejected by the shell, and the slow-lane list in scripts/test-lanes.mjs:14 already includes test/acceptance/critic-evidence.
**Decision:** The single story's `writes` array is exactly:
1. `packages/baro-orchestrator/src/acceptance/critic-evidence.ts`
2. `packages/baro-orchestrator/test/acceptance/critic-evidence.test.ts`
No other file may be created or modified — in particular not altitude.ts, altitude-probe.ts, gate-registry.ts, critic-verdict.ts, tui-protocol.ts, orchestrate.ts, package.json, or scripts/test-lanes.mjs (the lane list already covers this test file, so it needs no edit). No new dependency may be added. Declared verification commands, run from packages/baro-orchestrator with dependencies already installed at the repo root:
- `node --import tsx --test test/acceptance/critic-evidence.test.ts`
- `npx tsc -p tsconfig.json --noEmit`
If a test fails only under load, one isolated rerun of the same single-file command is authoritative.
**Consequences:** Any need to touch a file outside this list is a signal to stop and re-plan rather than widen the perimeter. Helper functions stay module-private inside critic-evidence.ts because no second file may be created to host them.
