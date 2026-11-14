import { defineConfig } from "@rstest/core"

// `process`: tests that spawn a CLI, drive git or run orchestrate() end to
// end. `unit` is everything else; a new file lands there unless it matches.
const PROCESS_TESTS = [
    "test/harness/**/*.test.ts",
    "test/integration/**/*.test.ts",
    "test/planning/adapters/**/*.test.ts",
    "test/app/**/*.test.ts",
    "test/execution/story-executor*.test.ts",
    "test/execution/shell-containment*.test.ts",
    "test/acceptance/critic-evidence*.test.ts",
    "test/acceptance/host-recheck*.test.ts",
    "test/acceptance/stale-evidence-recovery*.test.ts",
    "test/goal/goal-invariant-reviewer*.test.ts",
    "test/goal/goal-aggregate-governance*.test.ts",
    "test/conversation/dialogue-responder*.test.ts",
    "test/conversation/session/process-session-host*.test.ts",
    "test/conversation/session/autonomous-repository-scout*.test.ts",
    "test/verification/verify*.test.ts",
    "test/verification/run-verifier*.test.ts",
    "test/verification/declared-verification*.test.ts",
    "test/verification/command-timing*.test.ts",
    "test/operator/run-registry-base*.test.ts",
    "test/acceptance/altitude-probe*.test.ts",
    "test/execution/commit-reverification*.test.ts",
    "test/planning/story-write-surface*.test.ts",
    "test/architect-backend-mode*.test.ts",
    "test/**/*orchestrate*.test.ts",
    "test/**/*scripts-smoke*.test.ts",
    "test/**/*progressive-cli-smoke*.test.ts",
    "test/**/*story-tool-containment*.test.ts",
    "test/**/*run-architect-*.test.ts",
    "test/**/*run-conversation-script*.test.ts",
    "test/**/*runner-protocol*.test.ts",
    "test/**/*runner-helpers*.test.ts",
    "test/**/*agent-collab*.test.ts",
]

const shared = {
    testEnvironment: "node" as const,
    setupFiles: ["./test/env.ts"],
}

export default defineConfig({
    // Forks, because tests change process.env and signal handlers. Half the
    // cores: most wall time is child processes, not the worker.
    pool: { type: "forks", maxWorkers: "50%" },
    projects: [
        {
            ...shared,
            name: "unit",
            include: ["test/**/*.test.ts"],
            exclude: PROCESS_TESTS,
            testTimeout: 30_000,
            hookTimeout: 30_000,
        },
        {
            ...shared,
            name: "process",
            include: PROCESS_TESTS,
            // Bounds a hang: the slowest test is ~80 s alone, far more under load.
            testTimeout: 300_000,
            hookTimeout: 120_000,
        },
    ],
})
