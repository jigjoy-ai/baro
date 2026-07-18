import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { ManagedProcessTree } from "../../src/process-tree.js"
import { configureProviderOwnershipManifest } from "../../src/provider-ownership-manifest.js"

const manifestPath = requiredEnv("BARO_INTERNAL_PROVIDER_OWNERSHIP_MANIFEST")
const manifestToken = requiredEnv("BARO_INTERNAL_PROVIDER_OWNERSHIP_TOKEN")
delete process.env.BARO_INTERNAL_PROVIDER_OWNERSHIP_MANIFEST
delete process.env.BARO_INTERNAL_PROVIDER_OWNERSHIP_TOKEN
configureProviderOwnershipManifest(manifestPath, manifestToken)

const mode = process.argv[2]
let providerSpawned = false
process.on("SIGTERM", () => {
    if (mode === "late") spawnProvider()
})

if (mode === "live") {
    spawnProvider()
} else if (mode === "abrupt") {
    spawnProvider()
    // Simulate an uncaught fatal exit which bypasses the CLI's async
    // signalAllProcessTrees drain after the provider was durably registered.
    process.exit(17)
} else if (mode === "late") {
    writeFileSync(requiredEnv("BARO_TEST_STARTED"), "yes")
} else if (mode === "shim-exit") {
    spawnShimThenExit()
} else if (mode === "immediate-shim-abrupt") {
    spawnImmediateShimThenAbrupt()
} else {
    throw new Error(`unknown fixture mode: ${String(mode)}`)
}

setInterval(() => {}, 1_000)

function spawnProvider(): void {
    if (providerSpawned) return
    providerSpawned = true
    const provider = spawn(
        process.execPath,
        [
            "-e",
            `
const fs = require("node:fs")
if (process.env.BARO_INTERNAL_PROVIDER_OWNERSHIP_MANIFEST || process.env.BARO_INTERNAL_PROVIDER_OWNERSHIP_TOKEN) process.exit(91)
fs.writeFileSync(${JSON.stringify(requiredEnv("BARO_TEST_ENV_CLEAN"))}, "yes")
process.on("SIGTERM", () => {})
setInterval(() => {}, 1000)
`,
        ],
        { detached: true, stdio: "ignore" },
    )
    new ManagedProcessTree(provider, {
        ownsProcessGroup: true,
        pollIntervalMs: 20,
    })
    writeFileSync(requiredEnv("BARO_TEST_PROVIDER_PID"), String(provider.pid))
    writeFileSync(requiredEnv("BARO_TEST_STARTED"), "yes")
}

function spawnShimThenExit(): void {
    const memberPidPath = requiredEnv("BARO_TEST_PROVIDER_PID")
    const groupPidPath = requiredEnv("BARO_TEST_GROUP_PID")
    const releasePath = requiredEnv("BARO_TEST_RELEASE")
    const shim = spawn(
        process.execPath,
        [
            "-e",
            `
const fs = require("node:fs")
const { spawn } = require("node:child_process")
if (process.env.BARO_INTERNAL_PROVIDER_OWNERSHIP_MANIFEST || process.env.BARO_INTERNAL_PROVIDER_OWNERSHIP_TOKEN) process.exit(91)
fs.writeFileSync(${JSON.stringify(requiredEnv("BARO_TEST_ENV_CLEAN"))}, "yes")
const member = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
fs.writeFileSync(${JSON.stringify(memberPidPath)}, String(member.pid))
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
    })
    shim.once("exit", () => tree.markRootClosed())
    writeFileSync(groupPidPath, String(shim.pid))

    const observation = setInterval(() => {
        tree.refresh()
        if (!existsSync(memberPidPath)) return
        const memberPid = Number(readFileSync(memberPidPath, "utf8").trim())
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                providers: Array<{ members: Array<{ pid: number }> }>
            }
            const captured = manifest.providers.some((group) =>
                group.members.some((member) => member.pid === memberPid),
            )
            if (!captured) return
            clearInterval(observation)
            writeFileSync(releasePath, "release")
        } catch {
            // Retry across an atomic manifest generation boundary.
        }
    }, 20)
    shim.once("close", () => {
        writeFileSync(requiredEnv("BARO_TEST_STARTED"), "yes")
    })
}

function spawnImmediateShimThenAbrupt(): void {
    const memberPidPath = requiredEnv("BARO_TEST_PROVIDER_PID")
    const groupPidPath = requiredEnv("BARO_TEST_GROUP_PID")
    const shim = spawn(
        process.execPath,
        [
            "-e",
            `
const fs = require("node:fs")
const { spawn } = require("node:child_process")
if (process.env.BARO_INTERNAL_PROVIDER_OWNERSHIP_MANIFEST || process.env.BARO_INTERNAL_PROVIDER_OWNERSHIP_TOKEN) process.exit(91)
fs.writeFileSync(${JSON.stringify(requiredEnv("BARO_TEST_ENV_CLEAN"))}, "yes")
const member = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
fs.writeFileSync(${JSON.stringify(memberPidPath)}, String(member.pid))
process.exit(0)
`,
        ],
        { detached: true, stdio: "ignore" },
    )
    const tree = new ManagedProcessTree(shim, {
        ownsProcessGroup: true,
        pollIntervalMs: 20,
    })
    writeFileSync(groupPidPath, String(shim.pid))
    shim.once("exit", () => {
        tree.markRootClosed()
        writeFileSync(requiredEnv("BARO_TEST_STARTED"), "yes")
        // Crash the registry host immediately after the synchronous terminal
        // publication. No async observer turn or graceful drain is allowed.
        process.exit(17)
    })
}

function requiredEnv(name: string): string {
    const value = process.env[name]
    if (!value) throw new Error(`missing ${name}`)
    return value
}
