import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    realpathSync,
    writeFileSync,
} from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    materializeDependencies,
    npmCachePath,
} from "../../src/integration/dependency-materializer.js"
import { withTempDir } from "../execution/helpers.js"

// Every case injects runInstall, so npm is never spawned.

function writeWorkspace(
    dir: string,
    manifest: Record<string, unknown>,
    lockfile?: string,
): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
    if (lockfile !== undefined) writeFileSync(join(dir, "package-lock.json"), lockfile)
}

function recordingInstall(): { calls: string[]; runInstall: (dir: string) => Promise<void> } {
    const calls: string[] = []
    return {
        calls,
        runInstall: async (dir) => {
            calls.push(dir)
        },
    }
}

describe("materializeDependencies", () => {
    it("links the host node_modules when the root lockfile matches", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            writeWorkspace(host, { name: "root", private: true }, '{"lockfileVersion":3}')
            writeWorkspace(run, { name: "root", private: true }, '{"lockfileVersion":3}')
            mkdirSync(join(host, "node_modules"))
            const { calls, runInstall } = recordingInstall()

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall,
            })

            assert.deepEqual(result.workspaces, [
                { dir: run, action: "linked", reason: "lockfile matches host" },
            ])
            assert.equal(lstatSync(join(run, "node_modules")).isSymbolicLink(), true)
            assert.equal(
                realpathSync(join(run, "node_modules")),
                realpathSync(join(host, "node_modules")),
            )
            assert.deepEqual(calls, [], "a matching lockfile must not install")
        })
    })

    it("links every workspace whose lockfile content matches the host", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            for (const base of [host, run]) {
                writeWorkspace(
                    base,
                    { name: "root", private: true, workspaces: ["packages/*"] },
                    '{"lockfileVersion":3}',
                )
                writeWorkspace(join(base, "packages", "a"), { name: "@t/a" }, '{"name":"@t/a"}')
            }
            mkdirSync(join(host, "node_modules"))
            mkdirSync(join(host, "packages", "a", "node_modules"))
            const { calls, runInstall } = recordingInstall()

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall,
            })

            assert.deepEqual(result.workspaces, [
                { dir: run, action: "linked", reason: "lockfile matches host" },
                {
                    dir: join(run, "packages", "a"),
                    action: "linked",
                    reason: "lockfile matches host",
                },
            ])
            for (const { dir } of result.workspaces) {
                assert.equal(isAbsolute(dir), true)
                const fromRoot = relative(run, dir)
                assert.equal(fromRoot.startsWith(".."), false)
                assert.equal(lstatSync(join(dir, "node_modules")).isSymbolicLink(), true)
            }
            assert.deepEqual(calls, [])
        })
    })

    it("installs a workspace whose lockfile differs from the host twin", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            writeWorkspace(
                host,
                { name: "root", private: true, workspaces: ["packages/*"] },
                '{"lockfileVersion":3}',
            )
            writeWorkspace(join(host, "packages", "a"), { name: "@t/a" }, '{"name":"@t/a"}')
            mkdirSync(join(host, "node_modules"))
            mkdirSync(join(host, "packages", "a", "node_modules"))
            writeWorkspace(
                run,
                { name: "root", private: true, workspaces: ["packages/*"] },
                '{"lockfileVersion":3}',
            )
            writeWorkspace(
                join(run, "packages", "a"),
                { name: "@t/a" },
                '{"name":"@t/a","changed":true}',
            )
            const { calls, runInstall } = recordingInstall()

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall,
            })

            const workspace = join(run, "packages", "a")
            assert.deepEqual(result.workspaces, [
                { dir: run, action: "linked", reason: "lockfile matches host" },
                { dir: workspace, action: "installed", reason: "lockfile differs from host" },
            ])
            assert.deepEqual(calls, [workspace], "only the diverged workspace installs")
            assert.equal(existsSync(join(workspace, "node_modules")), false, "no symlink")
        })
    })

    it("installs when the host has no node_modules and skips an existing tree", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            for (const base of [host, run]) {
                writeWorkspace(
                    base,
                    { name: "root", private: true, workspaces: ["packages/*"] },
                    '{"lockfileVersion":3}',
                )
                writeWorkspace(join(base, "packages", "a"), { name: "@t/a" }, '{"name":"@t/a"}')
            }
            mkdirSync(join(run, "packages", "a", "node_modules"), { recursive: true })
            const { calls, runInstall } = recordingInstall()

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall,
            })

            assert.deepEqual(result.workspaces, [
                { dir: run, action: "installed", reason: "host has no node_modules" },
                {
                    dir: join(run, "packages", "a"),
                    action: "skipped",
                    reason: "node_modules already present",
                },
            ])
            assert.deepEqual(calls, [run])
        })
    })

    it("names the command, the workspace and the npm cache when an install fails", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            writeWorkspace(host, { name: "root", private: true }, '{"lockfileVersion":3}')
            writeWorkspace(run, { name: "root", private: true }, '{"lockfileVersion":2}')
            mkdirSync(join(host, "node_modules"))
            const cause = new Error("npm exited 1")

            await assert.rejects(
                materializeDependencies({
                    hostRoot: host,
                    integrationRoot: run,
                    runInstall: async () => {
                        throw cause
                    },
                }),
                (error: unknown) => {
                    assert.ok(error instanceof Error)
                    assert.match(error.message, /npm ci --prefer-offline/)
                    assert.ok(error.message.includes(run), error.message)
                    assert.ok(error.message.includes(npmCachePath()), error.message)
                    assert.equal(error.cause, cause)
                    return true
                },
            )
        })
    })

    it("does nothing when the host and the worktree are the same directory", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            writeWorkspace(root, { name: "root", private: true }, '{"lockfileVersion":3}')
            const before = readdirSync(root).sort()
            // Same directory reached by two spellings (/var vs /private/var).
            const canonical = realpathSync(root)

            const result = await materializeDependencies({
                hostRoot: root,
                integrationRoot: canonical,
                runInstall: async () => assert.fail("must not install in place"),
            })

            assert.deepEqual(result.workspaces, [
                {
                    dir: canonical,
                    action: "skipped",
                    reason: "host and worktree are the same directory",
                },
            ])
            assert.deepEqual(readdirSync(root).sort(), before)
            assert.equal(existsSync(join(root, "node_modules")), false)
        })
    })
})
