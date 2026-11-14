import { execFileSync } from "node:child_process"
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import assert from "node:assert/strict"
import { describe, it } from "@rstest/core"

import {
    materializeDependencies,
    npmCachePath,
} from "../../src/integration/dependency-materializer.js"
import { withTempDir } from "../execution/helpers.js"

// Every case but the #262 one injects runInstall; that one runs a
// dependency-free `npm ci`.

function writeWorkspace(
    dir: string,
    manifest: Record<string, unknown>,
    lockfile?: string,
): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
    if (lockfile !== undefined) writeFileSync(join(dir, "package-lock.json"), lockfile)
}

/** A host install that has its workspace members linked, as npm leaves it. */
function linkWorkspace(host: string, name: string): void {
    mkdirSync(join(host, "node_modules", name), { recursive: true })
}

function npm(cwd: string, args: string[]): void {
    execFileSync("npm", args, { cwd, stdio: "pipe", env: { ...process.env, BARO_SKIP_POSTINSTALL: "1" } })
}

function listTree(dir: string): string[] {
    const out: string[] = []
    const walk = (rel: string): void => {
        for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
            const path = rel ? `${rel}/${entry.name}` : entry.name
            if (entry.isDirectory()) walk(path)
            else out.push(path)
        }
    }
    walk("")
    return out.sort()
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
    // Smoke run 5: `js/package.json` with its own lockfile, no workspaces.
    // The final gate ran `node --test js/slug.test.mjs` without its deps.
    it("installs an independent package in a subdirectory that carries a lockfile", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            mkdirSync(host, { recursive: true })
            writeWorkspace(join(run, "js"), { name: "slug", private: true }, '{"lockfileVersion":3}')
            writeWorkspace(join(run, "tools", "unlocked"), { name: "unlocked", private: true })
            mkdirSync(join(run, "node_modules", "dep"), { recursive: true })
            writeWorkspace(join(run, "node_modules", "dep", "inner"), { name: "x" }, "{}")
            const { calls, runInstall } = recordingInstall()

            await materializeDependencies({ hostRoot: host, integrationRoot: run, runInstall })

            assert.deepEqual(calls, [join(run, "js")], "only the locked package, never inside node_modules")
        })
    })

    it("copies the host node_modules when the root lockfile matches", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            writeWorkspace(host, { name: "root", private: true }, '{"lockfileVersion":3}')
            writeWorkspace(run, { name: "root", private: true }, '{"lockfileVersion":3}')
            mkdirSync(join(host, "node_modules", "dep"), { recursive: true })
            writeFileSync(join(host, "node_modules", "dep", "index.js"), "module.exports = 1\n")
            const { calls, runInstall } = recordingInstall()

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall,
            })

            assert.equal(result.workspaces.length, 1)
            assert.equal(result.workspaces[0]!.action, "copied")
            assert.match(result.workspaces[0]!.reason, /^lockfile matches host \((cloned|hardlinked|copied)\)$/)
            assert.equal(lstatSync(join(run, "node_modules")).isSymbolicLink(), false, "a copy, never a link (#284)")
            assert.equal(
                readFileSync(join(run, "node_modules", "dep", "index.js"), "utf8"),
                "module.exports = 1\n",
            )
            assert.deepEqual(calls, [], "a matching lockfile must not install")
        })
    })

    it("copies every workspace whose lockfile content matches the host", async () => {
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
            linkWorkspace(host, "@t/a")
            mkdirSync(join(host, "packages", "a", "node_modules"))
            const { calls, runInstall } = recordingInstall()

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall,
            })

            assert.deepEqual(
                result.workspaces.map(({ dir, action }) => ({ dir, action })),
                [
                    { dir: run, action: "copied" },
                    { dir: join(run, "packages", "a"), action: "copied" },
                ],
            )
            for (const { dir } of result.workspaces) {
                assert.equal(isAbsolute(dir), true)
                const fromRoot = relative(run, dir)
                assert.equal(fromRoot.startsWith(".."), false)
                assert.equal(lstatSync(join(dir, "node_modules")).isSymbolicLink(), false)
            }
            assert.deepEqual(calls, [])
        })
    })

    // #284: with hoisting, a member has no node_modules of its own. `npm ci`
    // inside it resolves the root and reinstalls the whole tree.
    it("never installs in a workspace member that has no lockfile of its own", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            for (const base of [host, run]) {
                writeWorkspace(
                    base,
                    { name: "root", private: true, workspaces: ["packages/*"] },
                    '{"lockfileVersion":3}',
                )
                writeWorkspace(join(base, "packages", "a"), { name: "@t/a" })
            }
            linkWorkspace(host, "@t/a")
            const { calls, runInstall } = recordingInstall()

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall,
            })

            assert.deepEqual(result.workspaces.map(({ action, reason }) => ({ action, reason: reason.replace(/ \(.*\)$/, "") })), [
                { action: "copied", reason: "lockfile matches host" },
                { action: "skipped", reason: "installed by its workspace root" },
            ])
            assert.deepEqual(calls, [])
        })
    })

    it("installs when the host's install is older than its manifests", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            writeWorkspace(host, { name: "root", private: true }, '{"lockfileVersion":3}')
            writeWorkspace(run, { name: "root", private: true }, '{"lockfileVersion":3}')
            mkdirSync(join(host, "node_modules"))
            const marker = join(host, "node_modules", ".package-lock.json")
            writeFileSync(marker, "{}")
            const installedAt = new Date(Date.now() - 60_000)
            utimesSync(marker, installedAt, installedAt)
            const { calls, runInstall } = recordingInstall()

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall,
            })

            assert.deepEqual(result.workspaces, [
                { dir: run, action: "installed", reason: "host install is older than its manifests" },
            ])
            assert.deepEqual(calls, [run])
        })
    })

    it("replaces a dependency link left in the worktree, without touching what it points at", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            writeWorkspace(host, { name: "root", private: true }, '{"lockfileVersion":3}')
            writeWorkspace(run, { name: "root", private: true }, '{"lockfileVersion":3}')
            mkdirSync(join(host, "node_modules", "dep"), { recursive: true })
            symlinkSync(join(host, "node_modules"), join(run, "node_modules"), "dir")
            const { runInstall } = recordingInstall()

            await materializeDependencies({ hostRoot: host, integrationRoot: run, runInstall })

            assert.equal(lstatSync(join(run, "node_modules")).isSymbolicLink(), false)
            assert.equal(existsSync(join(run, "node_modules", "dep")), true)
            assert.equal(existsSync(join(host, "node_modules", "dep")), true)
        })
    })

    // #284, with the real npm: `npm ci` empties node_modules entry by entry
    // before it installs, and it does so through a link.
    it("lets an npm ci in the worktree run without emptying the host's node_modules", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            const manifests = (base: string): void => {
                writeWorkspace(base, { name: "root", private: true, version: "1.0.0", workspaces: ["packages/*"] })
                writeWorkspace(join(base, "packages", "a"), {
                    name: "@t/a",
                    version: "1.0.0",
                    dependencies: { "@t/b": "1.0.0" },
                })
                writeWorkspace(join(base, "packages", "b"), { name: "@t/b", version: "1.0.0" })
            }
            manifests(host)
            npm(host, ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--offline"])
            manifests(run)
            writeFileSync(join(run, "package-lock.json"), readFileSync(join(host, "package-lock.json")))
            const before = listTree(join(host, "node_modules"))
            assert.ok(before.includes("@t/a") && before.includes("@t/b"), before.join(", "))

            await materializeDependencies({ hostRoot: host, integrationRoot: run })
            npm(join(run, "packages", "a"), ["ci", "--no-audit", "--no-fund", "--ignore-scripts", "--offline"])

            assert.deepEqual(listTree(join(host, "node_modules")), before)
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
            linkWorkspace(host, "@t/a")
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
            assert.equal(result.workspaces[0]!.action, "copied")
            assert.deepEqual(result.workspaces[1], {
                dir: workspace,
                action: "installed",
                reason: "lockfile differs from host",
            })
            assert.deepEqual(calls, [workspace], "only the diverged workspace installs")
            assert.equal(existsSync(join(workspace, "node_modules")), false, "nothing copied in")
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

    it("never runs npm in a repository without a package.json (#210)", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            for (const dir of [host, run]) {
                mkdirSync(dir, { recursive: true })
                writeFileSync(join(dir, "pom.xml"), "<project/>")
            }
            const { calls, runInstall } = recordingInstall()

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall,
            })

            assert.deepEqual(calls, [])
            assert.deepEqual(
                result.workspaces.map(({ action, reason }) => ({ action, reason })),
                [{ action: "skipped", reason: "no package.json" }],
            )
        })
    })

    it("tells baro-ai's postinstall to leave the installed baro alone (#262)", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            mkdirSync(host, { recursive: true })
            const manifest = {
                name: "app",
                version: "1.0.0",
                private: true,
                scripts: {
                    postinstall:
                        "node -e \"require('fs').writeFileSync('seen', String(process.env.BARO_SKIP_POSTINSTALL))\"",
                },
            }
            const lockfile = JSON.stringify({
                name: "app",
                version: "1.0.0",
                lockfileVersion: 3,
                requires: true,
                packages: { "": { name: "app", version: "1.0.0" } },
            })
            writeWorkspace(run, manifest, lockfile)

            await materializeDependencies({ hostRoot: host, integrationRoot: run })

            assert.equal(readFileSync(join(run, "seen"), "utf8"), "1")
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
    // A fresh worktree has no `dist/`: every typecheck failed on `@baro/memory`.
    it("builds a workspace package another one imports when its entry is missing, dependencies first", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            mkdirSync(host, { recursive: true })
            const build = { build: "tsc" }
            writeWorkspace(run, { name: "root", private: true, workspaces: ["packages/*"] })
            writeWorkspace(join(run, "packages", "app"), {
                name: "app",
                dependencies: { "@x/core": "*", "@x/util": "*" },
            })
            writeWorkspace(join(run, "packages", "core"), {
                name: "@x/core",
                main: "dist/index.js",
                dependencies: { "@x/util": "*" },
                scripts: build,
            })
            writeWorkspace(join(run, "packages", "util"), {
                name: "@x/util",
                exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
                scripts: build,
            })
            writeWorkspace(join(run, "packages", "built"), { name: "@x/built", main: "lib/a.js", scripts: build })
            mkdirSync(join(run, "packages", "built", "lib"))
            writeFileSync(join(run, "packages", "built", "lib", "a.js"), "")
            writeWorkspace(join(run, "packages", "lonely"), { name: "@x/lonely", main: "dist/a.js", scripts: build })
            writeWorkspace(join(run, "packages", "nobuild"), { name: "@x/nobuild", main: "dist/a.js" })
            writeWorkspace(join(run, "packages", "uses"), {
                name: "uses",
                devDependencies: { "@x/built": "*", "@x/nobuild": "*" },
            })
            const built: string[] = []

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall: async () => {},
                runBuild: async (dir) => {
                    built.push(relative(run, dir))
                },
            })

            assert.deepEqual(built, [join("packages", "util"), join("packages", "core")])
            assert.deepEqual(
                result.workspaces.filter((w) => w.action === "built").map((w) => w.reason),
                ["./dist/index.d.ts is not in the checkout", "dist/index.js is not in the checkout"],
            )
        })
    })

    it("reports a failed build and goes on", async () => {
        await withTempDir("baro-dep-mat-", async (root) => {
            const host = join(root, "host")
            const run = join(root, "run")
            mkdirSync(host, { recursive: true })
            writeWorkspace(run, { name: "root", private: true, workspaces: ["packages/*"], dependencies: { lib: "*" } })
            writeWorkspace(join(run, "packages", "lib"), { name: "lib", main: "dist/a.js", scripts: { build: "tsc" } })

            const result = await materializeDependencies({
                hostRoot: host,
                integrationRoot: run,
                runInstall: async () => {},
                runBuild: async () => {
                    throw new Error("tsc exited 2")
                },
            })

            assert.deepEqual(result.workspaces.at(-1), {
                dir: join(run, "packages", "lib"),
                action: "build_failed",
                reason: "tsc exited 2",
            })
        })
    })
})
