import type {
    CancelMsg,
    DispatchMsg,
    DispatchRoute,
    EventMsg,
    PingMsg,
    PongMsg,
    RegisterMsg,
    ResultMsg,
    RunDispatchMsg,
    RunResultMsg,
    ToControl,
    ToRunner,
    WireEvent,
} from "./protocol.js"

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
        ? true
        : false
type Assert<T extends true> = T

type ExpectedRunDispatch = {
    t: "dispatch_run"
    runId: string
    goal: string
    workspaceId: string
    parallel: number
    timeoutSecs: number
    route?: DispatchRoute
}

type ExpectedRunResult = {
    t: "run_result"
    runId: string
    success: boolean
    durationSecs: number
    storiesPassed?: number
    storiesTotal?: number
    error: string | null
}

type _RunDispatchIsExact = Assert<Equal<RunDispatchMsg, ExpectedRunDispatch>>
type _RunResultIsExact = Assert<Equal<RunResultMsg, ExpectedRunResult>>
type _ToRunnerPreservesMembers = Assert<
    [DispatchMsg | RunDispatchMsg | CancelMsg | PingMsg] extends [ToRunner] ? true : false
>
type _ToControlPreservesMembers = Assert<
    [RegisterMsg | EventMsg | ResultMsg | RunResultMsg | PongMsg] extends [ToControl] ? true : false
>

const route: DispatchRoute = { backend: "claude", model: "sonnet" }

const dispatchWithoutRoute: RunDispatchMsg = {
    t: "dispatch_run",
    runId: "run-1",
    goal: "Implement the requested change",
    workspaceId: "workspace-1",
    parallel: 3,
    timeoutSecs: 900,
}

const dispatchWithRoute: RunDispatchMsg = {
    ...dispatchWithoutRoute,
    route,
}

const result: RunResultMsg = {
    t: "run_result",
    runId: "run-1",
    success: true,
    durationSecs: 42,
    storiesPassed: 2,
    storiesTotal: 2,
    error: null,
}

const toRunner: ToRunner = dispatchWithRoute
const toControl: ToControl = result

if (toRunner.t === "dispatch_run") {
    const goal: string = toRunner.goal
    const optionalRoute: DispatchRoute | undefined = toRunner.route
    void goal
    void optionalRoute
}

if (toControl.t === "run_result") {
    const error: string | null = toControl.error
    const passed: number | undefined = toControl.storiesPassed
    void error
    void passed
}

// @ts-expect-error goal is required for a whole-run dispatch
const invalidDispatch: RunDispatchMsg = {
    t: "dispatch_run",
    runId: "run-2",
    workspaceId: "workspace-2",
    parallel: 1,
    timeoutSecs: 60,
}

void invalidDispatch

declare const exactChecks: [
    _RunDispatchIsExact,
    _RunResultIsExact,
    _ToRunnerPreservesMembers,
    _ToControlPreservesMembers,
    WireEvent,
]
void exactChecks
