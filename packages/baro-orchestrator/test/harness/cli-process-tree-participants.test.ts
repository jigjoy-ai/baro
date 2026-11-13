import assert from "node:assert/strict"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { ClaudeCliParticipant } from "../../src/harness/claude/cli-participant.js"
import { CodexCliParticipant } from "../../src/harness/codex/cli-participant.js"
import { OpenCodeCliParticipant } from "../../src/harness/opencode/cli-participant.js"
import { PiCliParticipant } from "../../src/harness/pi/cli-participant.js"
import {
    activeProcessTreeCount,
    processTreeObserverStats,
    setProcessTreeDefaultTimingsForTests,
    signalAllProcessTrees,
    type ProcessTreeObserverStats,
} from "../../src/harness/process-tree.js"
import { killedWorkerFailure } from "../../src/harness/cli-story-failure.js"
import { captureEnv, withTempDir } from "../execution/helpers.js"
import { GENEROUS_WAIT_MS, waitFor, withDeadline } from "../wait-for.js"

describe("CLI participant process-tree lifecycle", () => {
    // Under load a `ps` scan can outlast the 5s TERM grace and the 2.25s
    // post-KILL bound; a positive certificate still needs an observed absence.
    before(() =>
        setProcessTreeDefaultTimingsForTests({
            terminationGraceMs: GENEROUS_WAIT_MS,
            quiescenceTimeoutMs: GENEROUS_WAIT_MS,
        }),
    )
    after(() => setProcessTreeDefaultTimingsForTests(null))

    it(
        "keeps all four harness trees registered after their shims close",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-cli-tree-matrix-", async (dir) => {
                const harnesses = ["claude", "codex", "opencode", "pi"] as const
                const fixtures = Object.fromEntries(
                    harnesses.map((name) => [name, writeTreeShim(dir, name)]),
                ) as Record<(typeof harnesses)[number], TreeShim>
                const participants = [
                    new ClaudeCliParticipant("claude-tree", {
                        cwd: dir,
                        claudeBin: fixtures.claude.bin,
                    }),
                    new CodexCliParticipant("codex-tree", {
                        cwd: dir,
                        prompt: "test",
                        codexBin: fixtures.codex.bin,
                        skipGitRepoCheck: true,
                    }),
                    new OpenCodeCliParticipant("opencode-tree", {
                        cwd: dir,
                        prompt: "test",
                        opencodeBin: fixtures.opencode.bin,
                    }),
                    new PiCliParticipant("pi-tree", {
                        cwd: dir,
                        prompt: "test",
                        piBin: fixtures.pi.bin,
                    }),
                ] as const

                for (const participant of participants) {
                    participant.start(captureEnv())
                }

                let descendantPids: number[] = []
                try {
                    await Promise.all(
                        participants.map((participant) => participant.ready),
                    )
                    descendantPids = harnesses.map((name) =>
                        Number(readFileSync(fixtures[name].pidPath, "utf8")),
                    )
                    assert.equal(activeProcessTreeCount(), 4)
                    // Once the shims close, only captured identities can be
                    // signalled; make sure a table read has captured them.
                    await waitForObserverIdleAfterScan(
                        processTreeObserverStats(),
                        GENEROUS_WAIT_MS,
                    )

                    signalAllProcessTrees("SIGTERM")
                    await waitFor(
                        () =>
                            participants.every(
                                (participant) => participant.getPhase() === "done",
                            ),
                        { message: "every shim to exit on SIGTERM" },
                    )
                    assert.equal(activeProcessTreeCount(), 4)
                    assert.ok(
                        descendantPids.every(isAlive),
                        "TERM-resistant descendants should remain for escalation",
                    )

                    signalAllProcessTrees("SIGKILL")
                    await Promise.all(
                        participants.map((participant) => participant.done),
                    )

                    assert.equal(activeProcessTreeCount(), 0)
                    await waitForReaped(descendantPids)
                } finally {
                    signalAllProcessTrees("SIGKILL")
                    for (const pid of descendantPids) {
                        try {
                            process.kill(pid, "SIGKILL")
                        } catch {
                            // already exited
                        }
                    }
                }
            })
        },
    )

    it(
        "finishes all four harnesses when a natural root exit leaves inherited stdio open",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-cli-inherited-stdio-", async (dir) => {
                const harnesses = ["claude", "codex", "opencode", "pi"] as const
                const fixtures = Object.fromEntries(
                    harnesses.map((name) => [
                        name,
                        writeInheritedStdioShim(dir, name),
                    ]),
                ) as Record<(typeof harnesses)[number], TriggeredTreeShim>
                // The tree, not the close-drain watchdog, must end these; a
                // long watchdog keeps a slow drain from being mistaken for it.
                const closeDrainTimeoutMs = GENEROUS_WAIT_MS
                const participants = [
                    new ClaudeCliParticipant("claude-inherited", {
                        cwd: dir,
                        claudeBin: fixtures.claude.bin,
                        closeDrainTimeoutMs,
                    }),
                    new CodexCliParticipant("codex-inherited", {
                        cwd: dir,
                        prompt: "test",
                        codexBin: fixtures.codex.bin,
                        skipGitRepoCheck: true,
                        closeDrainTimeoutMs,
                    }),
                    new OpenCodeCliParticipant("opencode-inherited", {
                        cwd: dir,
                        prompt: "test",
                        opencodeBin: fixtures.opencode.bin,
                        closeDrainTimeoutMs,
                    }),
                    new PiCliParticipant("pi-inherited", {
                        cwd: dir,
                        prompt: "test",
                        piBin: fixtures.pi.bin,
                        closeDrainTimeoutMs,
                    }),
                ] as const

                for (const participant of participants) {
                    participant.start(captureEnv())
                }

                let descendantPids: number[] = []
                try {
                    await Promise.all(
                        participants.map((participant) => participant.ready),
                    )
                    descendantPids = harnesses.map((name) =>
                        Number(readFileSync(fixtures[name].pidPath, "utf8")),
                    )
                    // Exit on cue once the providers are observed: a shim that
                    // left first under load took the group's identities with it.
                    await waitForObserverIdleAfterScan(
                        processTreeObserverStats(),
                        GENEROUS_WAIT_MS,
                    )
                    for (const name of harnesses) {
                        writeFileSync(fixtures[name].triggerPath, "exit")
                    }

                    const summaries = await withDeadline(
                        Promise.all(
                            participants.map((participant) => participant.done),
                        ),
                        GENEROUS_WAIT_MS * 2,
                        () =>
                            "natural root exit left inherited stdio open " +
                            JSON.stringify({
                                active: activeProcessTreeCount(),
                                phases: participants.map((participant) =>
                                    participant.getPhase(),
                                ),
                                alive: descendantPids.map(isAlive),
                            }),
                    )

                    assert.deepEqual(
                        summaries.map((summary) => summary.error?.message ?? null),
                        [null, null, null, null],
                        "the tree drained the inherited stdio; the watchdog did not fire",
                    )
                    assert.equal(activeProcessTreeCount(), 0)
                    await waitForReaped(descendantPids)
                } finally {
                    signalAllProcessTrees("SIGKILL")
                    for (const pid of descendantPids) {
                        try {
                            process.kill(pid, "SIGKILL")
                        } catch {
                            // already exited
                        }
                    }
                }
            })
        },
    )

    it(
        "contains all four unobserved children which inherit provider stdio",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-cli-close-watchdog-", async (dir) => {
                const harnesses = ["claude", "codex", "opencode", "pi"] as const
                const fixtures = Object.fromEntries(
                    harnesses.map((name) => [
                        name,
                        writeUnobservedInheritedStdioShim(dir, name),
                    ]),
                ) as Record<(typeof harnesses)[number], TriggeredTreeShim>
                const participants = [
                    new ClaudeCliParticipant("claude-watchdog", {
                        cwd: dir,
                        claudeBin: fixtures.claude.bin,
                        closeDrainTimeoutMs: 200,
                    }),
                    new CodexCliParticipant("codex-watchdog", {
                        cwd: dir,
                        prompt: "test",
                        codexBin: fixtures.codex.bin,
                        skipGitRepoCheck: true,
                        closeDrainTimeoutMs: 200,
                    }),
                    new OpenCodeCliParticipant("opencode-watchdog", {
                        cwd: dir,
                        prompt: "test",
                        opencodeBin: fixtures.opencode.bin,
                        closeDrainTimeoutMs: 200,
                    }),
                    new PiCliParticipant("pi-watchdog", {
                        cwd: dir,
                        prompt: "test",
                        piBin: fixtures.pi.bin,
                        closeDrainTimeoutMs: 200,
                    }),
                ] as const

                for (const participant of participants) {
                    participant.start(captureEnv())
                }

                let descendantPids: number[] = []
                try {
                    await Promise.all(
                        participants.map((participant) => participant.ready),
                    )
                    await waitForObserverIdleAfterScan(
                        processTreeObserverStats(),
                        GENEROUS_WAIT_MS,
                    )
                    for (const name of harnesses) {
                        writeFileSync(fixtures[name].triggerPath, "spawn")
                    }
                    await waitFor(
                        () => harnesses.every((name) =>
                            pidFileWritten(fixtures[name].pidPath),
                        ),
                        { message: "every unobserved child pid file" },
                    )
                    descendantPids = harnesses.map((name) =>
                        Number(readFileSync(fixtures[name].pidPath, "utf8")),
                    )

                    await withDeadline(
                        Promise.all(
                            participants.map((participant) => participant.done),
                        ),
                        GENEROUS_WAIT_MS,
                        () =>
                            "owned process groups did not contain every unobserved child",
                    )

                    const certifications = await Promise.all(
                        participants.map((participant) =>
                            participant.abortAndWait("SIGKILL"),
                        ),
                    )
                    assert.ok(
                        certifications.every(Boolean),
                        "every owned group must have an affirmative certificate",
                    )
                    await waitForReaped(
                        descendantPids,
                        "group containment must kill children which escaped PID discovery",
                    )
                    assert.equal(activeProcessTreeCount(), 0)
                } finally {
                    signalAllProcessTrees("SIGKILL")
                    for (const pid of descendantPids) {
                        try {
                            process.kill(pid, "SIGKILL")
                        } catch {
                            // already exited
                        }
                    }
                }
            })
        },
    )

    it(
        "bounds all four summaries while tracked trees clean up in background",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-cli-background-tree-", async (dir) => {
                const harnesses = ["claude", "codex", "opencode", "pi"] as const
                const fixtures = Object.fromEntries(
                    harnesses.map((name) => [
                        name,
                        writeTrackedInheritedStdioShim(dir, name),
                    ]),
                ) as Record<(typeof harnesses)[number], TriggeredTreeShim>
                const participants = [
                    new ClaudeCliParticipant("claude-background", {
                        cwd: dir,
                        claudeBin: fixtures.claude.bin,
                        closeDrainTimeoutMs: 200,
                    }),
                    new CodexCliParticipant("codex-background", {
                        cwd: dir,
                        prompt: "test",
                        codexBin: fixtures.codex.bin,
                        skipGitRepoCheck: true,
                        closeDrainTimeoutMs: 200,
                    }),
                    new OpenCodeCliParticipant("opencode-background", {
                        cwd: dir,
                        prompt: "test",
                        opencodeBin: fixtures.opencode.bin,
                        closeDrainTimeoutMs: 200,
                    }),
                    new PiCliParticipant("pi-background", {
                        cwd: dir,
                        prompt: "test",
                        piBin: fixtures.pi.bin,
                        closeDrainTimeoutMs: 200,
                    }),
                ] as const

                for (const participant of participants) {
                    participant.start(captureEnv())
                }

                let descendantPids: number[] = []
                try {
                    await Promise.all(
                        participants.map((participant) => participant.ready),
                    )
                    descendantPids = harnesses.map((name) =>
                        Number(readFileSync(fixtures[name].pidPath, "utf8")),
                    )
                    // The grandchildren exist before `ready`, so any table read
                    // after it captures them.
                    await waitForObserverIdleAfterScan(
                        processTreeObserverStats(),
                        GENEROUS_WAIT_MS,
                    )
                    for (const name of harnesses) {
                        writeFileSync(fixtures[name].triggerPath, "exit")
                    }

                    // Not bounding this below the 5s escalation: a summary that
                    // waited for the tree is caught by the liveness and
                    // tree-count assertions that follow.
                    const summaries = await withDeadline(
                        Promise.all(
                            participants.map((participant) => participant.done),
                        ),
                        GENEROUS_WAIT_MS,
                        () => "tracked process trees blocked watchdog summaries",
                    )

                    assert.ok(
                        summaries.every((summary) =>
                            summary.error?.message.includes(
                                "streams remained open",
                            ),
                        ),
                    )
                    assert.ok(descendantPids.every(isAlive))
                    assert.equal(
                        activeProcessTreeCount(),
                        4,
                        "tree ownership must survive bounded participant.done",
                    )
                    const quiescence = Promise.all(
                        participants.map((participant) =>
                            participant.abortAndWait("SIGKILL"),
                        ),
                    )
                    assert.ok(
                        participants.every(
                            (participant) => participant.getPhase() === "failed",
                        ),
                        "late abortAndWait must preserve the terminal failed phase",
                    )

                    const certifications = await withDeadline(
                        quiescence,
                        GENEROUS_WAIT_MS * 2,
                        () =>
                            "abortAndWait did not confirm watchdog tree quiescence " +
                            JSON.stringify({
                                active: activeProcessTreeCount(),
                                alive: descendantPids.map(isAlive),
                            }),
                    )
                    assert.ok(certifications.every(Boolean))
                    assert.equal(activeProcessTreeCount(), 0)
                    await waitForReaped(descendantPids)
                    await new Promise((resolve) => setTimeout(resolve, 50))
                    assert.ok(
                        participants.every(
                            (participant) => participant.getPhase() === "failed",
                        ),
                        "background cleanup must not overwrite watchdog failure",
                    )
                } finally {
                    signalAllProcessTrees("SIGKILL")
                    for (const pid of descendantPids) {
                        try {
                            process.kill(pid, "SIGKILL")
                        } catch {
                            // already exited
                        }
                    }
                }
            })
        },
    )
})

interface TreeShim {
    bin: string
    pidPath: string
}

interface TriggeredTreeShim extends TreeShim {
    triggerPath: string
}

function writeTreeShim(dir: string, name: string): TreeShim {
    const bin = join(dir, `${name}-tree-shim.mjs`)
    const pidPath = join(dir, `${name}-grandchild.pid`)
    const grandchildProgram = [
        'process.on("SIGTERM", () => {});',
        'console.log("ready");',
        "setInterval(() => {}, 1000);",
    ].join("")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => {
  writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
  console.log(JSON.stringify({ type: "thread.started", thread_id: "tree-thread" }));
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "tree-session" }));
  console.log(JSON.stringify({ type: "step_start", sessionID: "tree-session", part: { type: "step-start" } }));
  console.log(JSON.stringify({ type: "session", id: "tree-session" }));
  console.log(JSON.stringify({ type: "agent_start" }));
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    )
    chmodSync(bin, 0o755)
    return { bin, pidPath }
}

function writeInheritedStdioShim(dir: string, name: string): TriggeredTreeShim {
    const bin = join(dir, `${name}-inherited-stdio.mjs`)
    const pidPath = join(dir, `${name}-inherited-grandchild.pid`)
    const triggerPath = join(dir, `${name}-inherited-exit.trigger`)
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
console.log(JSON.stringify({ type: "thread.started", thread_id: "inherited-thread" }));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "inherited-session" }));
console.log(JSON.stringify({ type: "step_start", sessionID: "inherited-session", part: { type: "step-start" } }));
console.log(JSON.stringify({ type: "session", id: "inherited-session" }));
console.log(JSON.stringify({ type: "agent_start" }));
const trigger = setInterval(() => {
  if (!existsSync(${JSON.stringify(triggerPath)})) return;
  clearInterval(trigger);
  process.exit(0);
}, 1);
`,
    )
    chmodSync(bin, 0o755)
    return { bin, pidPath, triggerPath }
}

function writeUnobservedInheritedStdioShim(
    dir: string,
    name: string,
): TriggeredTreeShim {
    const bin = join(dir, `${name}-unobserved-stdio.mjs`)
    const pidPath = join(dir, `${name}-unobserved-grandchild.pid`)
    const triggerPath = join(dir, `${name}-spawn.trigger`)
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
console.log(JSON.stringify({ type: "thread.started", thread_id: "watchdog-thread" }));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "watchdog-session" }));
console.log(JSON.stringify({ type: "step_start", sessionID: "watchdog-session", part: { type: "step-start" } }));
console.log(JSON.stringify({ type: "session", id: "watchdog-session" }));
console.log(JSON.stringify({ type: "agent_start" }));
const trigger = setInterval(() => {
  if (!existsSync(${JSON.stringify(triggerPath)})) return;
  clearInterval(trigger);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
  process.exit(0);
}, 1);
`,
    )
    chmodSync(bin, 0o755)
    return { bin, pidPath, triggerPath }
}

function writeTrackedInheritedStdioShim(
    dir: string,
    name: string,
): TriggeredTreeShim {
    const bin = join(dir, `${name}-tracked-stdio.mjs`)
    const pidPath = join(dir, `${name}-tracked-grandchild.pid`)
    const triggerPath = join(dir, `${name}-exit.trigger`)
    const grandchildProgram = [
        'process.on("SIGTERM", () => {});',
        'process.send?.("ready");',
        "setInterval(() => {}, 1000);",
    ].join("")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.once("message", () => {
  writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
  console.log(JSON.stringify({ type: "thread.started", thread_id: "background-thread" }));
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "background-session" }));
  console.log(JSON.stringify({ type: "step_start", sessionID: "background-session", part: { type: "step-start" } }));
  console.log(JSON.stringify({ type: "session", id: "background-session" }));
  console.log(JSON.stringify({ type: "agent_start" }));
  const trigger = setInterval(() => {
    if (!existsSync(${JSON.stringify(triggerPath)})) return;
    clearInterval(trigger);
    process.exit(0);
  }, 1);
});
`,
    )
    chmodSync(bin, 0o755)
    return { bin, pidPath, triggerPath }
}

async function waitForObserverIdleAfterScan(
    before: ProcessTreeObserverStats,
    waitMs: number,
): Promise<void> {
    const deadline = Date.now() + waitMs
    let idleSince = 0
    let idleCompleted = -1
    while (Date.now() < deadline) {
        const stats = processTreeObserverStats()
        // A scan whose `ps` timed out under load completes but saw nothing.
        const idle =
            stats.lastObservedScan > before.scansStarted &&
            stats.activeScans === 0 &&
            stats.scansStarted === stats.scansCompleted
        if (!idle) {
            idleSince = 0
            idleCompleted = -1
        } else if (idleCompleted !== stats.scansCompleted) {
            idleSince = Date.now()
            idleCompleted = stats.scansCompleted
        } else if (Date.now() - idleSince >= 20) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 2))
    }
    throw new Error(`process-tree observer did not become idle within ${waitMs}ms`)
}

// A killed, reparented descendant answers `kill(pid, 0)` until init reaps it,
// which lags under load even after the tree saw it gone.
async function waitForReaped(
    pids: readonly number[],
    message = "every descendant to be reaped",
): Promise<void> {
    await waitFor(() => pids.every((pid) => !isAlive(pid)), { message })
}

// `existsSync` alone can observe the file between create and write; a pid of
// 0 would then make `process.kill` target this test's own process group.
function pidFileWritten(path: string): boolean {
    return existsSync(path) && /^\d+$/.test(readFileSync(path, "utf8"))
}

function isAlive(pid: number): boolean {
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
            const commandEnd = stat.lastIndexOf(")")
            if (
                commandEnd >= 0 &&
                stat.slice(commandEnd + 2, commandEnd + 3) === "Z"
            ) {
                return false
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
            // Fall through when procfs is unavailable or restricted.
        }
    }
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

describe("a worker the OS ended", () => {
    // Live run: seven of ten stories were killed by a signal. `close` fires
    // with code null, which the old phase test read as an ordinary finish, so
    // each was recorded `done`, retried to exhaustion, reported as `non-zero
    // exit null`, and finally read by the Guardian as proof the story was too
    // broad for one session — which it proposed to split. The DAG was being
    // rewritten around a signal.
    it(
        "is recorded as failed and names the signal",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-killed-worker-", async (dir) => {
                const bin = join(dir, "self-killing-claude.mjs")
                writeFileSync(
                    bin,
                    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }));
setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
setInterval(() => {}, 1000);
`,
                )
                chmodSync(bin, 0o755)
                const participant = new ClaudeCliParticipant("claude-killed", {
                    cwd: dir,
                    claudeBin: bin,
                })
                participant.start(captureEnv())
                const summary = await participant.done

                assert.equal(summary.exitCode, null)
                assert.equal(summary.exitSignal, "SIGKILL")
                assert.equal(
                    participant.getPhase(),
                    "failed",
                    "a killed worker did not finish its work",
                )
            })
        },
    )

    it("is classified as infrastructure, never as the agent's doing", () => {
        const killed = killedWorkerFailure("SIGKILL")
        assert.ok(killed)
        assert.equal(killed.failure.kind, "infrastructure")
        assert.equal(killed.failure.code, "process_killed")
        assert.match(killed.error, /SIGKILL/u)
        assert.equal(
            killedWorkerFailure(null),
            undefined,
            "an ordinary exit is not this",
        )
    })
})
