import { defineConfig } from "tsup"

/**
 * Bundles shipped in baro-ai's dist/ and spawned by the Rust runners
 * (orchestrator_client.rs, architect_runner.rs, planner_runner.rs).
 * postinstall.js stages them to ~/.baro/bin; the runners check there, then
 * the cwd's node_modules/baro-ai/dist/, then fall back to tsx from a dev
 * checkout. Workspace sources + @mozaik-ai/core are bundled in — published
 * .mjs files must have zero runtime deps beyond Node.
 */
const sharedBundleConfig = {
    format: ["esm" as const],
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" as const }),
    target: "node20" as const,
    platform: "node" as const,
    bundle: true,
    // esm splitting would emit shared chunk-*.mjs siblings that postinstall
    // doesn't stage into ~/.baro/bin — runners died with ERR_MODULE_NOT_FOUND.
    // Each entry must stay a single self-contained .mjs.
    splitting: false,
    noExternal: [
        /^@mozaik-ai\//,
        // @baro/memory's own TS must be bundled or the staged cli.mjs can't
        // resolve it (ERR_MODULE_NOT_FOUND silently disabled semantic memory
        // on every npm install). Its heavy ML deps stay external below —
        // they carry wasm/native assets esbuild can't inline.
        /^@baro\//,
    ],
    external: [
        // Embedding stack: resolved at runtime from node_modules links that
        // postinstall.js places next to the staged bundle.
        '@xenova/transformers',
        'sharp',
        'onnxruntime-node',
    ],
    clean: false,
    sourcemap: true,
    // Some transitive CJS deps call require() at load time (google-auth-library
    // via @mozaik-ai/core). esbuild's __require helper throws "Dynamic require
    // not supported" unless a real `require` is in scope — createRequire in
    // the banner provides it so CJS deps and Node builtins resolve at runtime.
    banner: {
        js: [
            "#!/usr/bin/env node",
            'import { createRequire as __baroCreateRequire } from "module";',
            "const require = __baroCreateRequire(import.meta.url);",
        ].join("\n"),
    },
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
    {
        entry: { "run-intake": "../baro-orchestrator/scripts/run-intake.ts" },
        ...sharedBundleConfig,
    },
    {
        entry: { "baro-memory": "../baro-orchestrator/scripts/baro-memory.ts" },
        ...sharedBundleConfig,
    },
    {
        entry: { "agent-collab": "../baro-orchestrator/scripts/agent-collab.mjs" },
        ...sharedBundleConfig,
    },
    {
        // `baro connect` runner — pairs with baro-cloud, runs dispatched goals.
        entry: { runner: "../baro-orchestrator/scripts/runner.ts" },
        ...sharedBundleConfig,
    },
])
