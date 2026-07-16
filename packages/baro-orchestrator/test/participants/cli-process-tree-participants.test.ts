import assert from "node:assert/strict"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { ClaudeCliParticipant } from "../../src/participants/claude-cli-participant.js"
import { CodexCliParticipant } from "../../src/participants/codex-cli-participant.js"
import { OpenCodeCliParticipant } from "../../src/participants/opencode-cli-participant.js"
import { PiCliParticipant } from "../../src/participants/pi-cli-participant.js"
import {
    activeProcessTreeCount,
    processTreeObserverStats,
    signalAllProcessTrees,
} from "../../src/process-tree.js"
import { captureEnv, withTempDir } from "./helpers.js"

describe("CLI participant process-tree lifecycle", () => {
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

                    signalAllProcessTrees("SIGTERM")
                    await waitUntil(
                        () =>
                            participants.every(
                                (participant) => participant.getPhase() === "done",
                            ),
                        1_000,
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
                    assert.ok(descendantPids.every((pid) => !isAlive(pid)))
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
                ) as Record<(typeof harnesses)[number], TreeShim>
                const participants = [
                    new ClaudeCliParticipant("claude-inherited", {
                        cwd: dir,
                        claudeBin: fixtures.claude.bin,
                    }),
                    new CodexCliParticipant("codex-inherited", {
                        cwd: dir,
                        prompt: "test",
                        codexBin: fixtures.codex.bin,
                        skipGitRepoCheck: true,
                    }),
                    new OpenCodeCliParticipant("opencode-inherited", {
                        cwd: dir,
                        prompt: "test",
                        opencodeBin: fixtures.opencode.bin,
                    }),
                    new PiCliParticipant("pi-inherited", {
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

                    await withDeadline(
                        Promise.all(
                            participants.map((participant) => participant.done),
                        ),
                        3_000,
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

                    assert.equal(activeProcessTreeCount(), 0)
                    assert.ok(descendantPids.every((pid) => !isAlive(pid)))
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
        "fails all four harnesses when an unobserved child holds inherited stdio",
        { skip: process.platform === "win32" },
        async () => {
            await withTempDir("baro-cli-close-watchdog-", async (dir) => {
                const harnesses = ["claude", "codex", "opencode", "pi"] as const
                const observerBefore = processTreeObserverStats()
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
                        observerBefore.scansCompleted,
                        2_000,
                    )
                    for (const name of harnesses) {
                        writeFileSync(fixtures[name].triggerPath, "spawn")
                    }
                    await waitUntil(
                        () => harnesses.every((name) =>
                            existsSync(fixtures[name].pidPath),
                        ),
                        1_000,
                    )
                    descendantPids = harnesses.map((name) =>
                        Number(readFileSync(fixtures[name].pidPath, "utf8")),
                    )

                    const summaries = await withDeadline(
                        Promise.all(
                            participants.map((participant) => participant.done),
                        ),
                        2_000,
                        () => "close/drain watchdog did not settle every harness",
                    )

                    assert.ok(
                        summaries.every((summary) =>
                            summary.error?.message.includes(
                                "streams remained open",
                            ),
                        ),
                    )
                    assert.ok(
                        participants.every(
                            (participant) => participant.getPhase() === "failed",
                        ),
                    )
                    assert.ok(
                        descendantPids.every(isAlive),
                        "fixture descendants must evade tree discovery",
                    )

                    for (const pid of descendantPids) process.kill(pid, "SIGKILL")
                    await waitUntil(
                        () => descendantPids.every((pid) => !isAlive(pid)),
                        2_000,
                    )
                    await new Promise((resolve) => setTimeout(resolve, 50))
                    assert.ok(
                        participants.every(
                            (participant) => participant.getPhase() === "failed",
                        ),
                        "late close must not overwrite watchdog failure",
                    )
                } finally {
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
                const observerBefore = processTreeObserverStats()
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
                    await waitForObserverIdleAfterScan(
                        observerBefore.scansCompleted,
                        2_000,
                    )
                    for (const name of harnesses) {
                        writeFileSync(fixtures[name].triggerPath, "exit")
                    }

                    const summaries = await withDeadline(
                        Promise.all(
                            participants.map((participant) => participant.done),
                        ),
                        2_000,
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
                    ClaudeCliParticipant.killAll("SIGTERM")
                    CodexCliParticipant.killAll("SIGTERM")
                    OpenCodeCliParticipant.killAll("SIGTERM")
                    PiCliParticipant.killAll("SIGTERM")
                    assert.ok(
                        participants.every(
                            (participant) => participant.getPhase() === "failed",
                        ),
                        "late killAll must preserve the terminal failed phase",
                    )

                    signalAllProcessTrees("SIGKILL")
                    await waitUntil(
                        () =>
                            activeProcessTreeCount() === 0 &&
                            descendantPids.every((pid) => !isAlive(pid)),
                        2_000,
                    )
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

function writeInheritedStdioShim(dir: string, name: string): TreeShim {
    const bin = join(dir, `${name}-inherited-stdio.mjs`)
    const pidPath = join(dir, `${name}-inherited-grandchild.pid`)
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
console.log(JSON.stringify({ type: "thread.started", thread_id: "inherited-thread" }));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "inherited-session" }));
console.log(JSON.stringify({ type: "step_start", sessionID: "inherited-session", part: { type: "step-start" } }));
console.log(JSON.stringify({ type: "session", id: "inherited-session" }));
console.log(JSON.stringify({ type: "agent_start" }));
setTimeout(() => process.exit(0), 250);
`,
    )
    chmodSync(bin, 0o755)
    return { bin, pidPath }
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
    scansCompletedBefore: number,
    waitMs: number,
): Promise<void> {
    const deadline = Date.now() + waitMs
    let idleSince = 0
    let idleCompleted = -1
    while (Date.now() < deadline) {
        const stats = processTreeObserverStats()
        const idle =
            stats.scansCompleted > scansCompletedBefore &&
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

async function waitUntil(predicate: () => boolean, waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`condition not reached within ${waitMs}ms`)
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

async function withDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: () => string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(timeoutMessage())),
                    timeoutMs,
                )
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}
