import { defineConfig } from "tsup"

/**
 * Three bundles ship inside the npm `baro-ai` package's `dist/`
 * directory:
 *
 *   - `cli.mjs`            — the Mozaik orchestrator CLI. Spawned by
 *                            `orchestrator_client.rs` once a story
 *                            execution starts.
 *   - `run-architect.mjs`  — TS Architect dispatcher. Spawned by
 *                            `architect_runner.rs` before planning.
 *   - `run-planner.mjs`    — TS Planner dispatcher. Spawned by
 *                            `planner_runner.rs` after the Architect.
 *
 * All three live next to the binary after `npm install -g baro-ai`
 * (postinstall.js copies them from `dist/` to `~/.baro/bin/`). The
 * Rust runners check that location first, then the cwd's
 * `node_modules/baro-ai/dist/`, then fall back to running the
 * TypeScript sources via `tsx` from a dev baro checkout.
 *
 * tsup follows imports across the workspace boundary so the
 * `@baro/orchestrator` source AND its `@mozaik-ai/core` dep are
 * bundled directly into each `.mjs` — published `.mjs` files have
 * zero runtime deps beyond Node + the npm packages already required
 * by baro-ai itself.
 */
const sharedBundleConfig = {
    format: ["esm" as const],
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" as const }),
    target: "node20" as const,
    platform: "node" as const,
    bundle: true,
    // Each entry must be a SINGLE self-contained .mjs. tsup defaults
    // `splitting: true` for esm, which hoists code shared across the
    // three entries into `chunk-*.mjs` siblings — and those chunks were
    // not staged into ~/.baro/bin by postinstall, so the runners died
    // with ERR_MODULE_NOT_FOUND (chunk-*.mjs). Disabling splitting
    // inlines everything back into each entry, matching the
    // "zero runtime deps, self-contained" contract documented above.
    splitting: false,
    // Force the Mozaik framework + the workspace orchestrator code
    // *into* the bundle so the published package is self-contained
    // (no runtime dependency on @mozaik-ai/core or @baro/orchestrator).
    noExternal: [
        /^@mozaik-ai\//,
        /^@baro\//,
    ],
    clean: false,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
}

export default defineConfig([
    {
        entry: { cli: "../baro-orchestrator/scripts/cli.ts" },
        ...sharedBundleConfig,
    },
    {
        entry: { "run-architect": "../baro-orchestrator/scripts/run-architect.ts" },
        ...sharedBundleConfig,
    },
    {
        entry: { "run-planner": "../baro-orchestrator/scripts/run-planner.ts" },
        ...sharedBundleConfig,
    },
])
