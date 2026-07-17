import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { describe, it } from "node:test"

import {
    activeProcessTreeCount,
    descendantsFromParentPairs,
    ManagedProcessTree,
    observedProcessGroupIsAlive,
    observedProcessIsAlive,
    parseLinuxProcStat,
    PROCESS_TREE_CAPABILITIES,
    processTreeObserverStats,
} from "../src/process-tree.js"

describe("process-tree discovery", () => {
    it("walks a parent table without including unrelated processes", () => {
        assert.deepEqual(
            descendantsFromParentPairs(10, [
                [11, 10],
                [12, 10],
                [13, 11],
                [99, 1],
            ]),
            [11, 12, 13],
        )
    })

    it("deduplicates malformed parent-table cycles", () => {
        assert.deepEqual(
            descendantsFromParentPairs(20, [
                [21, 20],
                [22, 21],
                [21, 22],
            ]),
            [21, 22],
        )
    })

    it("rejects zombies and recycled PIDs by process identity", () => {
        const identity = { pid: 42, startTime: "100" }
        assert.equal(
            observedProcessIsAlive(identity, {
                pid: 42,
                parentPid: 1,
                processGroupId: 42,
                state: "Z",
                startTime: "100",
            }),
            false,
        )
        assert.equal(
            observedProcessIsAlive(identity, {
                pid: 42,
                parentPid: 1,
                processGroupId: 42,
                state: "S",
                startTime: "101",
            }),
            false,
        )
        assert.equal(
            observedProcessIsAlive(identity, {
                pid: 42,
                parentPid: 1,
                processGroupId: 42,
                state: "S",
                startTime: "100",
            }),
            true,
        )

        const fields = Array.from({ length: 20 }, () => "0")
        fields[0] = "Z"
        fields[1] = "1"
        fields[2] = "42"
        fields[19] = "9001"
        assert.deepEqual(
            parseLinuxProcStat(`42 (provider helper) ${fields.join(" ")}`),
            {
                pid: 42,
                parentPid: 1,
                processGroupId: 42,
                state: "Z",
                startTime: "9001",
            },
        )
    })

    it("keeps an unknown process-table result fail-closed", () => {
        const member = {
            pid: 43,
            parentPid: 1,
            processGroupId: 42,
            state: "S",
            startTime: "100",
        }
        assert.equal(observedProcessGroupIsAlive(42, null), null)
        assert.equal(observedProcessGroupIsAlive(42, [member]), true)
        assert.equal(
            observedProcessGroupIsAlive(42, [
                { ...member, state: "Z" },
            ]),
            false,
        )
        assert.equal(observedProcessGroupIsAlive(42, []), false)
    })

    it("reports the Windows post-reap limitation explicitly", () => {
        assert.equal(
            PROCESS_TREE_CAPABILITIES.postRootCloseTrackedTermination,
            process.platform !== "win32",
        )
        assert.equal(
            PROCESS_TREE_CAPABILITIES.ownedProcessGroupTermination,
            process.platform === "linux" || process.platform === "darwin",
        )
        assert.equal(
            PROCESS_TREE_CAPABILITIES
                .ownedProcessGroupQuiescenceCertification,
            process.platform === "linux" || process.platform === "darwin",
        )
        assert.equal(
            PROCESS_TREE_CAPABILITIES
                .postRootCloseUnobservedDescendantDiscovery,
            false,
            "a reparented child needs prior observation or OS group ownership",
        )
    })

    it(
        "never signals an unobserved PID after its managed root was closed",
        { skip: process.platform === "win32" },
        async () => {
            // The live process models an unrelated process which received a
            // rapidly recycled PID. Marking the never-observed managed root as
            // closed must revoke the raw PID before any signal fallback runs.
            const unrelated = spawn(
                process.execPath,
                ["-e", "setInterval(() => {}, 1000)"],
                { stdio: "ignore" },
            )
            assert.ok(unrelated.pid !== undefined)
            const tree = new ManagedProcessTree(unrelated, {
                terminationGraceMs: 50,
                pollIntervalMs: 10,
            })

            try {
                // Both calls happen before the async observer can establish an
                // identity. This is the exact close/PID-reuse fallback edge.
                tree.markRootClosed()
                tree.terminate("SIGTERM")
                await tree.done

                assert.equal(
                    isAlive(unrelated.pid),
                    true,
                    "closed raw PID must not be used as signal authority",
                )
            } finally {
                try {
                    unrelated.kill("SIGKILL")
                } catch {
                    // already exited
                }
            }
        },
    )

    it(
        "certifies an owned POSIX group only after it disappears",
        {
            skip:
                process.platform !== "linux" &&
                process.platform !== "darwin",
        },
        async () => {
            const child = spawn(
                process.execPath,
                ["-e", "setInterval(() => {}, 1000)"],
                { detached: true, stdio: "ignore" },
            )
            const tree = new ManagedProcessTree(child, {
                ownsProcessGroup: true,
                terminationGraceMs: 50,
                pollIntervalMs: 10,
            })
            child.once("close", () => tree.markRootClosed())

            try {
                assert.equal(await tree.terminateAndWait("SIGKILL"), true)
                assert.equal(isAlive(child.pid!), false)
            } finally {
                tree.terminate("SIGKILL")
                try {
                    child.kill("SIGKILL")
                } catch {
                    // already exited
                }
            }
        },
    )

    it(
        "returns false after a bounded permanently-unknown group observation",
        {
            skip:
                process.platform !== "linux" &&
                process.platform !== "darwin",
        },
        async () => {
            const child = spawn(
                process.execPath,
                ["-e", "setInterval(() => {}, 1000)"],
                { detached: true, stdio: "ignore" },
            )
            const tree = new ManagedProcessTree(child, {
                ownsProcessGroup: true,
                terminationGraceMs: 25,
                pollIntervalMs: 10,
                quiescenceTimeoutMs: 50,
                processGroupObservation: () => null,
            })
            child.once("close", () => tree.markRootClosed())

            try {
                assert.equal(await tree.terminateAndWait("SIGKILL"), false)
                await tree.done
            } finally {
                try {
                    process.kill(-child.pid!, "SIGKILL")
                } catch {
                    // already exited
                }
            }
        },
    )

    it("returns false for a tree without OS-level group ownership", async () => {
        const child = spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { stdio: "ignore" },
        )
        const tree = new ManagedProcessTree(child, {
            terminationGraceMs: 50,
            pollIntervalMs: 10,
        })
        child.once("close", () => tree.markRootClosed())

        try {
            assert.equal(await tree.terminateAndWait("SIGKILL"), false)
            await tree.done
        } finally {
            tree.terminate("SIGKILL")
            try {
                child.kill("SIGKILL")
            } catch {
                // already exited
            }
        }
    })

    it(
        "uses one canonical Linux identity across async capture and sync signals",
        { skip: process.platform !== "linux" },
        async () => {
            const child = spawn(
                process.execPath,
                [
                    "-e",
                    [
                        'process.on("SIGTERM", () => console.log("term"));',
                        'console.log("ready");',
                        "setInterval(() => {}, 1000);",
                    ].join(""),
                ],
                { stdio: ["ignore", "pipe", "ignore"] },
            )
            const tree = new ManagedProcessTree(child, {
                terminationGraceMs: 75,
                pollIntervalMs: 10,
            })
            child.once("close", () => tree.markRootClosed())

            try {
                await waitForOutputText(child, "ready", 2_000)
                const before = processTreeObserverStats()
                tree.refresh()
                const requiredCompletions = before.activeScans > 0 ? 2 : 1
                await waitForCondition(
                    () =>
                        processTreeObserverStats().scansCompleted >=
                        before.scansCompleted + requiredCompletions,
                    2_000,
                )

                const observedTerm = waitForOutputText(child, "term", 1_000)
                tree.terminate("SIGTERM")
                await observedTerm
                await tree.done
                await waitForExit(child.pid!)

                assert.equal(isAlive(child.pid!), false)
            } finally {
                tree.terminate("SIGKILL")
                try {
                    child.kill("SIGKILL")
                } catch {
                    // already exited
                }
            }
        },
    )

    it(
        "shares one non-overlapping asynchronous observer across refresh storms",
        { skip: process.platform === "win32" },
        async () => {
            const shims = Array.from({ length: 4 }, () =>
                spawn(
                    process.execPath,
                    ["-e", "setTimeout(() => process.exit(0), 1000)"],
                    { stdio: "ignore" },
                ),
            )
            const trees = shims.map(
                (shim) =>
                    new ManagedProcessTree(shim, {
                        terminationGraceMs: 100,
                        pollIntervalMs: 10,
                    }),
            )
            shims.forEach((shim, index) => {
                shim.once("close", () => trees[index].markRootClosed())
            })

            try {
                const before = processTreeObserverStats()
                for (let pass = 0; pass < 25; pass += 1) {
                    for (const tree of trees) tree.refresh()
                }

                await waitForCondition(
                    () =>
                        processTreeObserverStats().scansCompleted >=
                        before.scansCompleted + 2,
                    2_000,
                )
                const after = processTreeObserverStats()
                assert.equal(after.maxConcurrentScans, 1)
                assert.ok(after.activeScans <= 1)
            } finally {
                for (const tree of trees) tree.terminate("SIGKILL")
                for (const shim of shims) {
                    try {
                        shim.kill("SIGKILL")
                    } catch {
                        // already exited
                    }
                }
                await Promise.all(trees.map((tree) => tree.done))
            }
        },
    )

    it(
        "retains an observed provider when its shim exits immediately afterward",
        { skip: process.platform === "win32" },
        async () => {
            const providerProgram = [
                'process.on("SIGTERM", () => {});',
                "setInterval(() => {}, 1000);",
            ].join("")
            const shimProgram = [
                'const { spawn } = require("node:child_process");',
                `const child = spawn(process.execPath, ["-e", ${JSON.stringify(providerProgram)}], { stdio: "ignore" });`,
                "console.log(child.pid);",
                "process.stdin.resume();",
                'process.stdin.once("data", () => process.exit(0));',
            ].join("")
            const shim = spawn(process.execPath, ["-e", shimProgram], {
                stdio: ["pipe", "pipe", "ignore"],
            })
            const tree = new ManagedProcessTree(shim, {
                terminationGraceMs: 100,
                pollIntervalMs: 10,
            })
            const closed = new Promise<void>((resolve) => {
                shim.once("close", () => {
                    tree.markRootClosed()
                    resolve()
                })
            })

            let providerPid: number | undefined
            try {
                providerPid = await firstNumericLine(shim)
                const before = processTreeObserverStats()
                tree.refresh()

                // If a scan was already in flight, refresh coalesces exactly
                // one follow-up. Wait for that post-output observation before
                // making the shim disappear.
                const requiredCompletions = before.activeScans > 0 ? 2 : 1
                await waitForCondition(
                    () =>
                        processTreeObserverStats().scansCompleted >=
                        before.scansCompleted + requiredCompletions,
                    2_000,
                )
                shim.stdin!.end("exit\n")

                await closed
                await tree.done
                await waitForExit(providerPid)
                assert.equal(isAlive(providerPid), false)
            } finally {
                tree.terminate("SIGKILL")
                try {
                    shim.kill("SIGKILL")
                } catch {
                    // already exited
                }
                if (providerPid !== undefined) {
                    try {
                        process.kill(providerPid, "SIGKILL")
                    } catch {
                        // already exited
                    }
                }
            }
        },
    )

    it(
        "retains a descendant snapshot and escalates after the direct shim closes",
        { skip: process.platform === "win32" },
        async () => {
            const grandchildProgram = [
                'process.on("SIGTERM", () => {});',
                'console.log("ready");',
                "setInterval(() => {}, 1000);",
            ].join("")
            const shimProgram = [
                'const { spawn } = require("node:child_process");',
                `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { stdio: ["ignore", "pipe", "ignore"] });`,
                'child.stdout.once("data", () => console.log(child.pid));',
                'process.on("SIGTERM", () => process.exit(0));',
                "setInterval(() => {}, 1000);",
            ].join("")
            const shim = spawn(process.execPath, ["-e", shimProgram], {
                stdio: ["ignore", "pipe", "ignore"],
            })
            const tree = new ManagedProcessTree(shim, {
                terminationGraceMs: 100,
                pollIntervalMs: 10,
            })
            shim.once("close", () => tree.markRootClosed())

            let grandchildPid: number | undefined
            try {
                grandchildPid = await firstNumericLine(shim)
                const startedAt = Date.now()
                tree.terminate("SIGTERM")
                await tree.done

                assert.ok(
                    Date.now() - startedAt >= 75,
                    "TERM-resistant grandchild should require timed SIGKILL",
                )
                assert.equal(isAlive(grandchildPid), false)
                assert.equal(activeProcessTreeCount(), 0)
            } finally {
                tree.terminate("SIGKILL")
                try {
                    shim.kill("SIGKILL")
                } catch {
                    // already exited
                }
                if (grandchildPid !== undefined) {
                    try {
                        process.kill(grandchildPid, "SIGKILL")
                    } catch {
                        // already exited
                    }
                }
            }
        },
    )

    it(
        "cleans stdio-detached descendants after natural zero and nonzero shim exits",
        { skip: process.platform === "win32" },
        async () => {
            for (const exitCode of [0, 7]) {
                const { shim, tree } = naturalExitTree(exitCode)
                let grandchildPid: number | undefined
                try {
                    grandchildPid = await firstNumericLine(shim)
                    const closed = new Promise<number | null>((resolve) => {
                        shim.once("close", (code) => {
                            tree.markRootClosed()
                            resolve(code)
                        })
                    })
                    assert.equal(await closed, exitCode)
                    await tree.done
                    await waitForExit(grandchildPid)

                    assert.equal(isAlive(grandchildPid), false)
                    assert.equal(activeProcessTreeCount(), 0)
                } finally {
                    tree.terminate("SIGKILL")
                    try {
                        shim.kill("SIGKILL")
                    } catch {
                        // already exited
                    }
                    if (grandchildPid !== undefined) {
                        try {
                            process.kill(grandchildPid, "SIGKILL")
                        } catch {
                            // already exited
                        }
                    }
                }
            }
        },
    )

    it(
        "uses taskkill while the Windows root is still live",
        { skip: process.platform !== "win32" },
        async () => {
            const childProgram = "setInterval(() => {}, 1000);"
            const shimProgram = [
                'const { spawn } = require("node:child_process");',
                `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { stdio: "ignore" });`,
                "console.log(child.pid);",
                "setInterval(() => {}, 1000);",
            ].join("")
            const shim = spawn(process.execPath, ["-e", shimProgram], {
                stdio: ["ignore", "pipe", "ignore"],
            })
            const tree = new ManagedProcessTree(shim, {
                terminationGraceMs: 100,
                pollIntervalMs: 10,
            })
            shim.once("close", () => tree.markRootClosed())
            let descendantPid: number | undefined
            try {
                descendantPid = await firstNumericLine(shim)
                tree.terminate("SIGTERM")
                await tree.done
                await waitForExit(descendantPid)
                assert.equal(isAlive(descendantPid), false)
            } finally {
                tree.terminate("SIGKILL")
                if (descendantPid !== undefined) {
                    try {
                        process.kill(descendantPid, "SIGKILL")
                    } catch {
                        // already exited
                    }
                }
            }
        },
    )
})

function naturalExitTree(exitCode: number): {
    shim: ReturnType<typeof spawn>
    tree: ManagedProcessTree
} {
    const grandchildProgram = [
        'process.on("SIGTERM", () => {});',
        'console.log("ready");',
        "setInterval(() => {}, 1000);",
    ].join("")
    const shimProgram = [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { stdio: ["ignore", "pipe", "ignore"] });`,
        `child.stdout.once("data", () => { console.log(child.pid); setTimeout(() => process.exit(${exitCode}), 250); });`,
        "setInterval(() => {}, 1000);",
    ].join("")
    const shim = spawn(process.execPath, ["-e", shimProgram], {
        stdio: ["ignore", "pipe", "ignore"],
    })
    return {
        shim,
        tree: new ManagedProcessTree(shim, {
            terminationGraceMs: 100,
            pollIntervalMs: 10,
        }),
    }
}

function firstNumericLine(child: ReturnType<typeof spawn>): Promise<number> {
    return new Promise((resolve, reject) => {
        let buffer = ""
        const timeout = setTimeout(
            () => reject(new Error("timed out waiting for grandchild pid")),
            2_000,
        )
        child.once("error", reject)
        child.stdout!.setEncoding("utf8")
        child.stdout!.on("data", (chunk: string) => {
            buffer += chunk
            const line = buffer.split("\n", 1)[0]?.trim()
            if (!/^\d+$/.test(line)) return
            clearTimeout(timeout)
            resolve(Number(line))
        })
    })
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
    }
}

async function waitForExit(pid: number): Promise<void> {
    const deadline = Date.now() + 2_000
    while (isAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

async function waitForCondition(
    condition: () => boolean,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
        if (Date.now() >= deadline) {
            throw new Error("timed out waiting for process-tree condition")
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

function waitForOutputText(
    child: ReturnType<typeof spawn>,
    expected: string,
    timeoutMs: number,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let buffer = ""
        const onData = (chunk: Buffer | string): void => {
            buffer += chunk.toString()
            if (!buffer.includes(expected)) return
            cleanup()
            resolve()
        }
        const onError = (error: Error): void => {
            cleanup()
            reject(error)
        }
        const timeout = setTimeout(() => {
            cleanup()
            reject(new Error(`timed out waiting for output: ${expected}`))
        }, timeoutMs)
        const cleanup = (): void => {
            clearTimeout(timeout)
            child.stdout?.off("data", onData)
            child.off("error", onError)
        }

        child.stdout?.on("data", onData)
        child.once("error", onError)
    })
}
