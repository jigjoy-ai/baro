import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { cargoEnvFor, resolveCargoTargetDir } from "../../src/verification/cargo-env.js"
import { verifyBuild, type VerifyPlan } from "../../src/verification/verify.js"
import { withTempDir } from "../execution/helpers.js"

describe("resolveCargoTargetDir", () => {
    it("reuses the host checkout's target/ when it exists", async () => {
        await withTempDir("baro-cargo-env-host-", async (host) => {
            mkdirSync(join(host, "target"))
            assert.equal(resolveCargoTargetDir(host, {}), join(host, "target"))
        })
    })

    it("returns a preset CARGO_TARGET_DIR unchanged", async () => {
        await withTempDir("baro-cargo-env-preset-", async (host) => {
            mkdirSync(join(host, "target"))
            assert.equal(
                resolveCargoTargetDir(host, { CARGO_TARGET_DIR: "/somewhere/else" }),
                "/somewhere/else",
            )
        })
    })

    it("ignores an empty CARGO_TARGET_DIR", async () => {
        await withTempDir("baro-cargo-env-empty-", async (host) => {
            mkdirSync(join(host, "target"))
            assert.equal(resolveCargoTargetDir(host, { CARGO_TARGET_DIR: "" }), join(host, "target"))
        })
    })

    it("falls back to a stable per-repository cache when the host has no target/", async () => {
        await withTempDir("baro-cargo-env-a-", async (hostA) => {
            await withTempDir("baro-cargo-env-b-", async (hostB) => {
                const cacheRoot = join(homedir(), ".baro", "cargo-target")
                const first = resolveCargoTargetDir(hostA, {})
                const second = resolveCargoTargetDir(hostA, {})
                const other = resolveCargoTargetDir(hostB, {})

                assert.ok(first.startsWith(`${cacheRoot}/`), `${first} is not under ${cacheRoot}`)
                assert.equal(first, second)
                assert.notEqual(first, other)
                assert.ok(existsSync(first), "the cache directory is created recursively")
                assert.ok(existsSync(other))

                rmSync(first, { recursive: true, force: true })
                rmSync(other, { recursive: true, force: true })
            })
        })
    })
})

describe("cargoEnvFor", () => {
    it("adds CARGO_TARGET_DIR to the given env without dropping its other entries", async () => {
        await withTempDir("baro-cargo-env-for-", async (host) => {
            mkdirSync(join(host, "target"))
            const env = cargoEnvFor(host, { PATH: "/bin", OTHER: "kept" })

            assert.equal(env.CARGO_TARGET_DIR, join(host, "target"))
            assert.equal(env.PATH, "/bin")
            assert.equal(env.OTHER, "kept")
        })
    })

    it("keeps a caller's CARGO_TARGET_DIR", async () => {
        await withTempDir("baro-cargo-env-for-preset-", async (host) => {
            mkdirSync(join(host, "target"))
            assert.equal(
                cargoEnvFor(host, { CARGO_TARGET_DIR: "/pinned" }).CARGO_TARGET_DIR,
                "/pinned",
            )
        })
    })
})

// The spec's `tool` is the literal "cargo", so a stub of that name on PATH
// proves the wiring end-to-end without building anything.
describe("verifyBuild cargo environment", () => {
    it("gives cargo the host target dir and leaves other tools' env alone", async () => {
        await withTempDir("baro-cargo-env-run-host-", async (host) => {
            await withTempDir("baro-cargo-env-run-", async (run) => {
                mkdirSync(join(host, "target"))
                const binDir = join(run, "bin")
                mkdirSync(binDir)
                writeFileSync(
                    join(binDir, "cargo"),
                    '#!/bin/sh\nprintf "%s" "${CARGO_TARGET_DIR-unset}" > "$1"\n',
                )
                chmodSync(join(binDir, "cargo"), 0o755)

                const cargoOut = join(run, "cargo.txt")
                const nodeOut = join(run, "node.txt")
                const plan: VerifyPlan = {
                    commands: [
                        { label: "cargo build", tool: "cargo", args: [cargoOut] },
                        {
                            label: "node probe",
                            tool: "node",
                            args: [
                                "-e",
                                "require('fs').writeFileSync(process.argv[1], String(process.env.CARGO_TARGET_DIR))",
                                nodeOut,
                            ],
                        },
                    ],
                }

                const originalPath = process.env.PATH
                const originalTargetDir = process.env.CARGO_TARGET_DIR
                process.env.PATH = `${binDir}:${originalPath ?? ""}`
                delete process.env.CARGO_TARGET_DIR
                try {
                    const result = await verifyBuild(run, {
                        plan,
                        hostRepoRoot: host,
                        emitActivity: () => {},
                    })
                    assert.deepEqual(
                        result.commands.map((command) => command.status),
                        ["passed", "passed"],
                        JSON.stringify(result.commands),
                    )
                } finally {
                    process.env.PATH = originalPath
                    if (originalTargetDir !== undefined) {
                        process.env.CARGO_TARGET_DIR = originalTargetDir
                    }
                }

                assert.equal(readFileSync(cargoOut, "utf8"), join(host, "target"))
                assert.equal(readFileSync(nodeOut, "utf8"), "undefined")
            })
        })
    })

    it("targets the run cwd when no hostRepoRoot is given", async () => {
        await withTempDir("baro-cargo-env-default-", async (run) => {
            mkdirSync(join(run, "target"))
            const binDir = join(run, "bin")
            mkdirSync(binDir)
            writeFileSync(
                join(binDir, "cargo"),
                '#!/bin/sh\nprintf "%s" "${CARGO_TARGET_DIR-unset}" > "$1"\n',
            )
            chmodSync(join(binDir, "cargo"), 0o755)

            const out = join(run, "cargo.txt")
            const plan: VerifyPlan = {
                commands: [{ label: "cargo build", tool: "cargo", args: [out] }],
            }

            const originalPath = process.env.PATH
            const originalTargetDir = process.env.CARGO_TARGET_DIR
            process.env.PATH = `${binDir}:${originalPath ?? ""}`
            delete process.env.CARGO_TARGET_DIR
            try {
                await verifyBuild(run, { plan, emitActivity: () => {} })
            } finally {
                process.env.PATH = originalPath
                if (originalTargetDir !== undefined) {
                    process.env.CARGO_TARGET_DIR = originalTargetDir
                }
            }

            assert.equal(readFileSync(out, "utf8"), join(run, "target"))
        })
    })
})
