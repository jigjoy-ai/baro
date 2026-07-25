import type {
    DispatchMsg,
    DispatchRoute,
    RejectMsg,
    RunDispatchMsg,
    ToRunner,
} from "./protocol.js"

const story: DispatchMsg = {
    t: "dispatch",
    storyId: "story-1",
    prompt: "Do the work",
    route: { backend: "claude" },
    retries: 1,
    timeoutSecs: 300,
    workspaceId: "workspace-1",
}

const run: RunDispatchMsg = {
    t: "dispatch_run",
    runId: "run-1",
    goal: "Do the whole run",
    workspaceId: "workspace-1",
    parallel: 2,
    timeoutSecs: 900,
    route: { backend: "codex" } satisfies DispatchRoute,
}

const rejection: RejectMsg = {
    t: "rejected",
    reason: "pairing token expired",
}

const variants: ToRunner[] = [story, run, rejection]

for (const message of variants) {
    if (message.t === "dispatch_run") {
        const goal: string = message.goal
        void goal
    }
    if (message.t === "rejected") {
        const reason: string = message.reason
        void reason
    }
}
