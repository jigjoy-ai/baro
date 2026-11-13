import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "@rstest/core"

import {
    activeProcessTreeCount,
    descendantsFromParentPairs,
    ManagedProcessTree,
    observedProcessGroupIsAlive,
    observedProcessIsAlive,
    parseLinuxProcStat,
    PROCESS_TREE_CAPABILITIES,
    processTreeObserverStats,
    setProcessTreeOwnershipPublisherForTests,
    type ProcessTreeObserverStats,
} from "../../src/harness/process-tree.js"
import {
    GENEROUS_WAIT_MS,
    isPidAlive as isAlive,
    waitFor,
    waitForPidExit,
} from "../wait-for.js"

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
                .cooperativeQuiescenceObservation,
            process.platform === "linux" || process.platform === "darwin",
        )
        assert.deepEqual(PROCESS_TREE_CAPABILITIES.quiescenceAssurance, {
            maximum:
                process.platform === "linux" || process.platform === "darwin"
                    ? "cooperative-observed"
                    : "none",
            mechanism:
                process.platform === "linux" || process.platform === "darwin"
                    ? "posix-owned-group-plus-identity-table"
                    : "uncontained-process-tree",
            rulesOutUnobservedDetachedDescendants: false,
        })
        assert.equal(
            PROCESS_TREE_CAPABILITIES
                .postRootCloseUnobservedDescendantDiscovery,
            false,
            "a reparented child needs prior observation or OS group ownership",
        )
    })

    it.skipIf(process.platform === "win32")("never signals an unobserved PID after its managed root was closed",
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

    it.skipIf(process.platform !== "linux" &&
                process.platform !== "darwin",)("certifies an owned POSIX group only after it disappears",
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
                quiescenceTimeoutMs: GENEROUS_WAIT_MS,
            })
            child.once("close", () => tree.markRootClosed())

            try {
                const [quiesced, observation] = await Promise.all([
                    tree.terminateAndWait("SIGKILL"),
                    tree.terminateAndObserve("SIGKILL"),
                ])
                assert.equal(quiesced, true)
                assert.deepEqual(observation, {
                    assurance: "cooperative-observed",
                    mechanism: "posix-owned-group-plus-identity-table",
                    groupAbsent: true,
                    trackedAbsent: true,
                })
                // Absent from the table can still be an unreaped zombie here.
                await waitForPidExit(child.pid!)
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

    it.skipIf(process.platform !== "linux" &&
                process.platform !== "darwin",)("returns false after a bounded permanently-unknown group observation",
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

    it.skipIf(process.platform === "win32")("certifies an ordinary exit from the group probe, without a process-table read",
        async () => {
            const child = spawn(process.execPath, ["-e", ""], {
                stdio: "ignore",
                detached: true,
            })
            const tree = new ManagedProcessTree(child, { ownsProcessGroup: true })
            const before = processTreeObserverStats()
            child.once("exit", () => tree.markRootClosed())

            assert.deepEqual(await tree.quiescenceObservation, {
                assurance: "cooperative-observed",
                mechanism: "posix-owned-group-plus-identity-table",
                groupAbsent: true,
                trackedAbsent: true,
            })
            assert.equal(
                processTreeObserverStats().terminalTableReads,
                before.terminalTableReads,
            )
        },
    )

    it.skipIf(process.platform === "win32")("reads the process table when a group member outlives the root",
        async () => {
            const survivorProgram =
                'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'
            const shimProgram = [
                'const { spawn } = require("node:child_process");',
                `const child = spawn(process.execPath, ["-e", ${JSON.stringify(survivorProgram)}], { stdio: ["ignore", "pipe", "ignore"] });`,
                'child.stdout.once("data", () => { console.log(child.pid); process.exit(0); });',
            ].join("")
            const shim = spawn(process.execPath, ["-e", shimProgram], {
                stdio: ["ignore", "pipe", "ignore"],
                detached: true,
            })
            const tree = new ManagedProcessTree(shim, {
                ownsProcessGroup: true,
                terminationGraceMs: 100,
                pollIntervalMs: 10,
            })
            let survivorPid: number | undefined
            try {
                const exited = new Promise<void>((resolve) => {
                    shim.once("exit", () => resolve())
                })
                survivorPid = await firstNumericLine(shim)
                await exited
                const before = processTreeObserverStats()

                tree.markRootClosed()

                assert.equal(
                    processTreeObserverStats().terminalTableReads,
                    before.terminalTableReads + 1,
                )
                assert.equal(activeProcessTreeCount(), 1)
                assert.equal(isAlive(survivorPid), true)

                assert.equal(await tree.terminateAndWait("SIGKILL"), true)
                await waitForPidExit(survivorPid)
            } finally {
                tree.terminate("SIGKILL")
                if (survivorPid !== undefined) {
                    try {
                        process.kill(survivorPid, "SIGKILL")
                    } catch {
                        // already exited
                    }
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

    it.skipIf(process.platform !== "linux")("uses one canonical Linux identity across async capture and sync signals",
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
                await waitForOutputText(child, "ready", GENEROUS_WAIT_MS)
                const before = processTreeObserverStats()
                tree.refresh()
                await waitFor(observedSince(before))

                const observedTerm = waitForOutputText(child, "term", GENEROUS_WAIT_MS)
                tree.terminate("SIGTERM")
                await observedTerm
                await tree.done
                await waitForPidExit(child.pid!)

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

    it.skipIf(process.platform === "win32")("shares one non-overlapping asynchronous observer across refresh storms",
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

                await waitFor(
                    () =>
                        processTreeObserverStats().scansCompleted >=
                        before.scansCompleted + 2,
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

    it.skipIf(process.platform === "win32")("retains an observed provider when its shim exits immediately afterward",
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

                // Wait for a post-output observation before making the shim
                // disappear.
                await waitFor(observedSince(before))
                shim.stdin!.end("exit\n")

                await closed
                await tree.done
                await waitForPidExit(providerPid)
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

    it.skipIf(process.platform === "win32")("retains a descendant snapshot and escalates after the direct shim closes",
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
                const before = processTreeObserverStats()
                tree.refresh()
                await waitFor(observedSince(before))
                const startedAt = Date.now()
                tree.terminate("SIGTERM")
                await tree.done

                assert.ok(
                    Date.now() - startedAt >= 75,
                    "TERM-resistant grandchild should require timed SIGKILL",
                )
                await waitForPidExit(grandchildPid)
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

    it.skipIf(process.platform === "win32")("cleans stdio-detached descendants after natural zero and nonzero shim exits",
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
                    const before = processTreeObserverStats()
                    tree.refresh()
                    await waitFor(observedSince(before))
                    shim.stdin!.end("exit\n")
                    assert.equal(await closed, exitCode)
                    await tree.done
                    await waitForPidExit(grandchildPid)

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

    it.skipIf(process.platform !== "linux" &&
                process.platform !== "darwin",)("drains an identity-captured descendant that creates a new process group",
        async () => {
            const dir = await mkdtemp(join(tmpdir(), "baro-detached-tree-"))
            const latePath = join(dir, "late.txt")
            const goPath = join(dir, "go")
            // Triggered rather than timed: a fixed delay raced the verdict
            // under load and wrote before the tree had finished draining.
            const writerProgram = [
                'const fs = require("node:fs");',
                'process.on("SIGTERM", () => {});',
                `setInterval(() => { if (fs.existsSync(${JSON.stringify(goPath)})) fs.writeFileSync(${JSON.stringify(latePath)}, "late"); }, 10);`,
            ].join("")
            const shimProgram = [
                'const { spawn } = require("node:child_process");',
                `const child = spawn(process.execPath, ["-e", ${JSON.stringify(writerProgram)}], { detached: true, stdio: "ignore" });`,
                "console.log(child.pid);",
                "process.stdin.resume();",
                'process.stdin.once("data", () => process.exit(0));',
            ].join("")
            const shim = spawn(process.execPath, ["-e", shimProgram], {
                detached: true,
                stdio: ["pipe", "pipe", "ignore"],
            })
            const tree = new ManagedProcessTree(shim, {
                ownsProcessGroup: true,
                terminationGraceMs: 50,
                pollIntervalMs: 10,
                quiescenceTimeoutMs: GENEROUS_WAIT_MS,
            })
            const closed = new Promise<void>((resolve) => {
                shim.once("close", () => {
                    tree.markRootClosed()
                    resolve()
                })
            })
            let writerPid: number | undefined

            try {
                writerPid = await firstNumericLine(shim)
                const before = processTreeObserverStats()
                tree.refresh()
                await waitFor(observedSince(before))
                assert.ok(
                    tree.ownershipSnapshots()?.some(
                        (group) => group.processGroupId === writerPid,
                    ),
                    "crash-recovery ownership includes the observed escaped group",
                )

                shim.stdin!.end("exit\n")
                await closed
                assert.equal(await tree.quiescence, true)
                await waitForPidExit(writerPid)
                assert.equal(isAlive(writerPid), false)

                // Prove the positive verdict was not merely early: an escaped
                // child still alive after it would write on this trigger.
                await writeFile(goPath, "go")
                await new Promise((resolve) => setTimeout(resolve, 200))
                await assert.rejects(readFile(latePath, "utf8"), /ENOENT/)
            } finally {
                tree.terminate("SIGKILL")
                try {
                    process.kill(-shim.pid!, "SIGKILL")
                } catch {
                    // already exited
                }
                if (writerPid !== undefined) {
                    try {
                        process.kill(writerPid, "SIGKILL")
                    } catch {
                        // already exited
                    }
                }
                await rm(dir, { recursive: true, force: true })
            }
        },
    )

    it.skipIf(process.platform !== "linux" &&
                process.platform !== "darwin",)("fails closed when newly observed ownership membership cannot be published",
        async () => {
            let generation = 0
            let failedPublications = 0
            let publicationCalls = 0
            setProcessTreeOwnershipPublisherForTests((groups) => {
                publicationCalls++
                if (groups.length > 2) {
                    failedPublications++
                    return {
                        ok: false,
                        error: "injected membership publication failure",
                    }
                }
                return { ok: true, generation: ++generation }
            })

            const stable = spawn(
                process.execPath,
                ["-e", "setInterval(() => {}, 1000);"],
                { detached: true, stdio: "ignore" },
            )
            const stableTree = new ManagedProcessTree(stable, {
                ownsProcessGroup: true,
                terminationGraceMs: 50,
                pollIntervalMs: 10,
                quiescenceTimeoutMs: 500,
            })
            stable.once("close", () => stableTree.markRootClosed())

            const childProgram = "setInterval(() => {}, 1000);"
            const shimProgram = [
                'const { spawn } = require("node:child_process");',
                'process.stdin.setEncoding("utf8");',
                'process.stdin.once("data", () => {',
                `  const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { detached: true, stdio: "ignore" });`,
                "  console.log(child.pid);",
                "});",
                "setInterval(() => {}, 1000);",
            ].join("")
            const shim = spawn(process.execPath, ["-e", shimProgram], {
                detached: true,
                stdio: ["pipe", "pipe", "ignore"],
            })
            const tree = new ManagedProcessTree(shim, {
                ownsProcessGroup: true,
                terminationGraceMs: 50,
                pollIntervalMs: 10,
                quiescenceTimeoutMs: 500,
            })
            shim.once("close", () => tree.markRootClosed())
            let childPid: number | undefined

            try {
                // The constructor's synchronous `ps -p` can time out under
                // load; the shared observer then registers within its grace.
                await waitFor(() => generation >= 2, {
                    message: "both root memberships to be durably registered first",
                })
                const childPidPromise = firstNumericLine(shim)
                shim.stdin!.end("spawn\n")
                childPid = await childPidPromise
                tree.refresh()

                await tree.done
                await waitForPidExit(childPid)
                await waitForPidExit(shim.pid!)

                assert.ok(failedPublications >= 1)
                assert.equal(isAlive(shim.pid!), false)
                assert.equal(isAlive(childPid), false)
                assert.equal(
                    isAlive(stable.pid!),
                    true,
                    "the unchanged, already-published sibling must survive",
                )
                assert.equal(activeProcessTreeCount(), 1)
                assert.ok(
                    publicationCalls < 10,
                    "failure handling must not recursively republish ownership",
                )
            } finally {
                tree.terminate("SIGKILL")
                try {
                    process.kill(-shim.pid!, "SIGKILL")
                } catch {
                    // already exited
                }
                if (childPid !== undefined) {
                    try {
                        process.kill(childPid, "SIGKILL")
                    } catch {
                        // already exited
                    }
                }
                await tree.done
                stableTree.terminate("SIGKILL")
                try {
                    process.kill(-stable.pid!, "SIGKILL")
                } catch {
                    // already exited
                }
                await stableTree.done
                setProcessTreeOwnershipPublisherForTests(null)
            }
        },
    )

    it.skipIf(process.platform !== "linux" &&
                process.platform !== "darwin",)("a young neighbour without a snapshot does not poison the batch publish",
        async () => {
            let generation = 0
            const publishedCounts: number[] = []
            setProcessTreeOwnershipPublisherForTests((groups) => {
                publishedCounts.push(groups.length)
                return { ok: true, generation: ++generation }
            })

            const stable = spawn(
                process.execPath,
                ["-e", "setInterval(() => {}, 1000);"],
                { detached: true, stdio: "ignore" },
            )
            const stableTree = new ManagedProcessTree(stable, {
                ownsProcessGroup: true,
                terminationGraceMs: 50,
                pollIntervalMs: 10,
                quiescenceTimeoutMs: 500,
            })
            stable.once("close", () => stableTree.markRootClosed())

            let young: ReturnType<typeof spawn> | undefined
            let youngTree: ManagedProcessTree | undefined
            try {
                const before = processTreeObserverStats()
                stableTree.refresh()
                await waitFor(
                    () => generation >= 1,
                )

                // A neighbour whose root exits before any observation keeps
                // an empty member table — ownershipSnapshots() stays null
                // while the tree drains. This exact state used to fail the
                // WHOLE publish and fail-closed-kill every concurrently
                // spawning worker (the serial SIGKILLs of runs 12–15).
                young = spawn(process.execPath, ["-e", "process.exit(0)"], {
                    detached: true,
                    stdio: "ignore",
                })
                youngTree = new ManagedProcessTree(young, {
                    ownsProcessGroup: true,
                    terminationGraceMs: 50,
                    pollIntervalMs: 10,
                    quiescenceTimeoutMs: 500,
                })
                const youngRef = young
                const youngClosed = new Promise<void>((resolve) => {
                    youngRef.once("close", () => {
                        youngTree?.markRootClosed()
                        resolve()
                    })
                })
                await youngClosed

                const generationBefore = generation
                const scansBefore = processTreeObserverStats().scansCompleted
                stableTree.refresh()
                await waitFor(
                    () =>
                        processTreeObserverStats().scansCompleted >=
                        scansBefore + 1,
                )
                await waitFor(
                    () => generation > generationBefore,
                )

                assert.equal(isAlive(stable.pid!), true, "registered sibling survives")
                assert.ok(
                    publishedCounts.length > 0 &&
                        publishedCounts[publishedCounts.length - 1]! >= 1,
                    "the observed sibling still reaches the manifest",
                )
                void before
            } finally {
                stableTree.terminate("SIGKILL")
                youngTree?.terminate("SIGKILL")
                for (const proc of [stable, young]) {
                    if (!proc?.pid) continue
                    try {
                        process.kill(-proc.pid, "SIGKILL")
                    } catch {
                        // already exited
                    }
                }
                await stableTree.done
                if (youngTree) await youngTree.done
                setProcessTreeOwnershipPublisherForTests(null)
            }
        },
    )

    it.skipIf(process.platform !== "win32")("uses taskkill while the Windows root is still live",
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
                await waitForPidExit(descendantPid)
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
        'child.stdout.once("data", () => console.log(child.pid));',
        // Exit on cue, not after a fixed delay that can beat the observer.
        `process.stdin.once("data", () => process.exit(${exitCode}));`,
    ].join("")
    const shim = spawn(process.execPath, ["-e", shimProgram], {
        stdio: ["pipe", "pipe", "ignore"],
    })
    return {
        shim,
        tree: new ManagedProcessTree(shim, {
            terminationGraceMs: 100,
            pollIntervalMs: 10,
        }),
    }
}

// Only a scan that started after `before` and actually read a table counts:
// a `ps` that times out under load completes without observing anything.
function observedSince(before: ProcessTreeObserverStats): () => boolean {
    return () =>
        processTreeObserverStats().lastObservedScan > before.scansStarted
}

function firstNumericLine(child: ReturnType<typeof spawn>): Promise<number> {
    return new Promise((resolve, reject) => {
        let buffer = ""
        const timeout = setTimeout(
            () => reject(new Error("timed out waiting for grandchild pid")),
            GENEROUS_WAIT_MS,
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
