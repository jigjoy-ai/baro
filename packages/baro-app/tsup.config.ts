import { defineConfig } from "tsup"

/**
 * One bundle ships inside the npm `baro-ai` package's `dist/`
 * directory: `cli.mjs`, the Mozaik orchestrator CLI bundled with all
 * its TS sources (including the @mozaik-ai/core framework). Spawned
 * by `crates/baro-tui/src/orchestrator_client.rs` after a user runs
 * `npm install -g baro-ai`. The Rust client looks for it at
 * `node_modules/baro-ai/dist/cli.mjs`.
 *
 * (The legacy `openai-planner.js` bundle from `src/core/openai-planner.ts`
 * was removed in 0.32: the standalone planner subprocess is replaced
 * by `scripts/run-planner.ts` in the orchestrator package, which the
 * Rust `planner_runner` spawns via tsx.)
 *
 * The orchestrator entry point lives in the sibling workspace package
 * `@baro/orchestrator`. tsup follows the imports across the workspace
 * boundary, bundles everything (including @mozaik-ai/core) into a
 * single ESM file with a node shebang.
 */
export default defineConfig([
    {
        entry: { cli: "../baro-orchestrator/scripts/cli.ts" },
        format: ["esm"],
        outDir: "dist",
        outExtension: () => ({ js: ".mjs" }),
        target: "node20",
        platform: "node",
        bundle: true,
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
    },
])
