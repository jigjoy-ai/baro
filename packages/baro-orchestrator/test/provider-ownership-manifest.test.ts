import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"

import {
    configureProviderOwnershipManifest,
    publishProviderOwnership,
    resetProviderOwnershipManifestForTests,
} from "../src/provider-ownership-manifest.js"
import {
    ManagedProcessTree,
    POSIX_PROCESS_GROUPS_SUPPORTED,
} from "../src/process-tree.js"

const TOKEN = "provider-ownership-test-token"
let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
    await cleanup?.()
    cleanup = null
    resetProviderOwnershipManifestForTests()
})

describe("provider ownership manifest", () => {
    it("rejects a bootstrap that was not created for this run", () => {
        const fixture = manifestFixture("different-token")
        cleanup = async () => fixture.remove()
        assert.throws(
            () => configureProviderOwnershipManifest(fixture.path, TOKEN),
            /does not match this run/,
        )
    })

    it("atomically replaces a bounded complete snapshot", () => {
        const fixture = manifestFixture(TOKEN)
        cleanup = async () => fixture.remove()
        configureProviderOwnershipManifest(fixture.path, TOKEN)
        const result = publishProviderOwnership([
            {
                processGroupId: 4312,
                identitySource: "linux-proc-stat-v1",
                members: [{ pid: 4312, startTime: "99" }],
            },
        ])
        assert.equal(result.ok, true)

        const manifest = JSON.parse(readFileSync(fixture.path, "utf8"))
        assert.equal(manifest.schemaVersion, 1)
        assert.equal(manifest.runToken, TOKEN)
        assert.deepEqual(manifest.providers, [
            {
                processGroupId: 4312,
                identitySource: "linux-proc-stat-v1",
                members: [{ pid: 4312, startTime: "99" }],
            },
        ])
    })

    it("preserves the last complete generation instead of truncating capacity overflow", () => {
        const fixture = manifestFixture(TOKEN)
        cleanup = async () => fixture.remove()
        configureProviderOwnershipManifest(fixture.path, TOKEN)
        const accepted = publishProviderOwnership([
            {
                processGroupId: 4312,
                identitySource: "linux-proc-stat-v1",
                members: [{ pid: 4312, startTime: "99" }],
            },
        ])
        assert.equal(accepted.ok, true)
        const before = readFileSync(fixture.path, "utf8")

        const overflow = publishProviderOwnership(
            Array.from({ length: 513 }, (_, index) => ({
                processGroupId: 10_000 + index,
                identitySource: "linux-proc-stat-v1" as const,
                members: [{ pid: 10_000 + index, startTime: String(index + 1) }],
            })),
        )

        assert.equal(overflow.ok, false)
        assert.match(
            overflow.ok ? "" : overflow.error,
            /capacity exceeded/,
        )
        assert.equal(readFileSync(fixture.path, "utf8"), before)
    })

    it("kills a newly spawned owned group when its first durable registration fails", {
        skip: !POSIX_PROCESS_GROUPS_SUPPORTED,
    }, async () => {
        const fixture = manifestFixture(TOKEN)
        configureProviderOwnershipManifest(fixture.path, TOKEN)
        fixture.remove()

        const child = spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { detached: true, stdio: "ignore" },
        )
        const tree = new ManagedProcessTree(child, {
            ownsProcessGroup: true,
            pollIntervalMs: 10,
            terminationGraceMs: 50,
            quiescenceTimeoutMs: 500,
        })
        child.once("exit", () => tree.markRootClosed())
        cleanup = async () => {
            tree.terminate("SIGKILL")
            await Promise.race([
                tree.done,
                new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
            ])
            hardKill(child)
        }

        await waitFor(() => !processAlive(child.pid), 2_000)
        assert.equal(processAlive(child.pid), false)
    })

    it("publishes a live same-group provider when its shim exits immediately", {
        skip: !POSIX_PROCESS_GROUPS_SUPPORTED,
    }, async () => {
        const fixture = manifestFixture(TOKEN)
        const providerPidPath = join(fixture.directory, "immediate-provider-pid")
        configureProviderOwnershipManifest(fixture.path, TOKEN)
        const shim = spawn(
            process.execPath,
            [
                "-e",
                `
const fs = require("node:fs")
const { spawn } = require("node:child_process")
const provider = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
fs.writeFileSync(${JSON.stringify(providerPidPath)}, String(provider.pid))
process.exit(0)
`,
            ],
            { detached: true, stdio: "ignore" },
        )
        const tree = new ManagedProcessTree(shim, {
            ownsProcessGroup: true,
            pollIntervalMs: 20,
            terminationGraceMs: 50,
            quiescenceTimeoutMs: 500,
        })
        const rootExited = new Promise<void>((resolve) => {
            shim.once("exit", () => {
                tree.markRootClosed()
                resolve()
            })
        })
        cleanup = async () => {
            tree.terminate("SIGKILL")
            await Promise.race([
                tree.done,
                new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
            ])
            hardKill(shim)
            fixture.remove()
        }

        await waitFor(() => fileNumber(providerPidPath) !== null)
        const providerPid = fileNumber(providerPidPath)!
        await rootExited

        assert.equal(
            manifestHasMember(fixture.path, providerPid),
            true,
            "terminal shim handoff was not synchronously persisted",
        )
        assert.equal(processAlive(providerPid), true)
    })

    it("certifies a clean root exit without reporting an ownership failure", {
        skip: !POSIX_PROCESS_GROUPS_SUPPORTED,
    }, async () => {
        const fixture = manifestFixture(TOKEN)
        configureProviderOwnershipManifest(fixture.path, TOKEN)
        const child = spawn(
            process.execPath,
            ["-e", "setTimeout(() => process.exit(0), 25)"],
            { detached: true, stdio: "ignore" },
        )
        const rootPid = child.pid!
        const warnings: string[] = []
        const onWarning = (warning: Error): void => {
            if (warning.message.includes(`process group ${rootPid}`)) {
                warnings.push(warning.message)
            }
        }
        process.on("warning", onWarning)
        const tree = new ManagedProcessTree(child, {
            ownsProcessGroup: true,
            pollIntervalMs: 10,
            terminationGraceMs: 50,
            quiescenceTimeoutMs: 500,
        })
        child.once("exit", () => tree.markRootClosed())
        cleanup = async () => {
            process.off("warning", onWarning)
            tree.terminate("SIGKILL")
            await Promise.race([
                tree.done,
                new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
            ])
            hardKill(child)
            fixture.remove()
        }

        await tree.done
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.deepEqual(warnings, [])
        const manifest = JSON.parse(readFileSync(fixture.path, "utf8"))
        assert.deepEqual(manifest.providers, [])
    })

    it(
        "retains an observed same-group provider after its short-lived shim exits",
        { skip: !POSIX_PROCESS_GROUPS_SUPPORTED },
        async () => {
            const fixture = manifestFixture(TOKEN)
            const providerPidPath = join(fixture.directory, "provider-pid")
            const releasePath = join(fixture.directory, "release")
            configureProviderOwnershipManifest(fixture.path, TOKEN)

            const shim = spawn(
                process.execPath,
                [
                    "-e",
                    `
const fs = require("node:fs")
const { spawn } = require("node:child_process")
const provider = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
fs.writeFileSync(${JSON.stringify(providerPidPath)}, String(provider.pid))
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releasePath)})) return
  clearInterval(timer)
  process.exit(0)
}, 10)
`,
                ],
                { detached: true, stdio: "ignore" },
            )
            const tree = new ManagedProcessTree(shim, {
                ownsProcessGroup: true,
                pollIntervalMs: 20,
                terminationGraceMs: 100,
                quiescenceTimeoutMs: 500,
            })
            cleanup = async () => {
                tree.terminate("SIGKILL")
                await Promise.race([
                    tree.done,
                    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
                ])
                hardKill(shim)
                fixture.remove()
            }

            await waitFor(() => fileNumber(providerPidPath) !== null)
            const providerPid = fileNumber(providerPidPath)!
            tree.refresh()
            await waitFor(() => manifestHasMember(fixture.path, providerPid))

            writeFileSync(releasePath, "release")
            await waitForChildClose(shim)
            tree.refresh()
            await waitFor(() => manifestHasMember(fixture.path, providerPid))

            const manifest = JSON.parse(readFileSync(fixture.path, "utf8"))
            const group = manifest.providers.find(
                (entry: { processGroupId: number }) =>
                    entry.processGroupId === shim.pid,
            )
            assert.ok(group, "provider group disappeared with its shim")
            assert.ok(
                group.members.some(
                    (member: { pid: number }) => member.pid === providerPid,
                ),
            )
            assert.equal(processAlive(shim.pid), false)
            assert.equal(processAlive(providerPid), true)
        },
    )
})

function manifestFixture(token: string): {
    directory: string
    path: string
    remove: () => void
} {
    const directory = mkdtempSync(join(tmpdir(), "baro-ownership-test-"))
    const path = join(directory, "ownership.json")
    writeFileSync(
        path,
        JSON.stringify({
            schemaVersion: 1,
            runToken: token,
            generation: 0,
            providers: [],
        }),
        { mode: 0o600 },
    )
    return {
        directory,
        path,
        remove: () => rmSync(directory, { recursive: true, force: true }),
    }
}

function manifestHasMember(path: string, pid: number): boolean {
    try {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as {
            providers: Array<{ members: Array<{ pid: number }> }>
        }
        return manifest.providers.some((group) =>
            group.members.some((member) => member.pid === pid),
        )
    } catch {
        return false
    }
}

function fileNumber(path: string): number | null {
    try {
        const value = Number(readFileSync(path, "utf8").trim())
        return Number.isSafeInteger(value) && value > 0 ? value : null
    } catch {
        return null
    }
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 3_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("condition timed out")
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

async function waitForChildClose(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => child.once("close", () => resolve()))
}

function processAlive(pid: number | undefined): boolean {
    if (pid === undefined) return false
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

function hardKill(child: ChildProcess): void {
    if (child.pid === undefined) return
    try {
        process.kill(-child.pid, "SIGKILL")
    } catch {
        // Already gone.
    }
}
