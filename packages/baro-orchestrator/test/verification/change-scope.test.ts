import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "@rstest/core"

import {
    affectedEcosystems,
    changedPathsSince,
    scopeCommandsToChange,
} from "../../src/verification/change-scope.js"
import { verifyBuild, type VerifyCommandSpec, type VerifyPlan } from "../../src/verification/verify.js"
import { withTempDir } from "../execution/helpers.js"

// The shape of Baro itself: a Rust workspace under crates/ and npm workspaces under packages/.
function polyglot(root: string): void {
    writeFileSync(join(root, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\n')
    mkdirSync(join(root, "crates", "tui", "src"), { recursive: true })
    writeFileSync(join(root, "crates", "tui", "Cargo.toml"), '[package]\nname = "tui"\n')
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
    mkdirSync(join(root, "packages", "core", "src"), { recursive: true })
    writeFileSync(join(root, "packages", "core", "package.json"), "{}")
}

const cargoTest: VerifyCommandSpec = { label: "cargo test", tool: "cargo", args: ["test"] }
const nodeTest: VerifyCommandSpec = {
    label: "node --test (test)",
    tool: "node",
    args: ["--test"],
    cwd: "/x/packages/core",
}
const npmBuild: VerifyCommandSpec = { label: "npm run build", tool: "npm", args: ["run", "build"] }
const declaredJs: VerifyCommandSpec = { ...npmBuild, label: "declared", origin: "declared" }
const hygiene: VerifyCommandSpec = { label: "git diff --check", tool: "git", args: ["diff", "--check"] }

describe("affectedEcosystems", () => {
    it("places each changed file in the ecosystem whose build reads it", async () => {
        await withTempDir("baro-scope-", async (root) => {
            polyglot(root)
            assert.deepEqual([...affectedEcosystems(["crates/tui/src/main.rs"], root) as Set<string>], ["rust"])
            // A fixture inside a crate is read by include_str!, so it is Rust's.
            assert.deepEqual([...affectedEcosystems(["crates/tui/fixtures/a.json"], root) as Set<string>], ["rust"])
            assert.deepEqual([...affectedEcosystems(["packages/core/src/a.ts"], root) as Set<string>], ["javascript"])
            assert.deepEqual([...affectedEcosystems(["packages/core/fixtures/a.json"], root) as Set<string>], ["javascript"])
            assert.deepEqual([...affectedEcosystems(["package-lock.json"], root) as Set<string>], ["javascript"])
            assert.deepEqual([...affectedEcosystems(["Cargo.lock"], root) as Set<string>], ["rust"])
        })
    })

    it("ignores documentation and runs everything for a file it cannot place", async () => {
        await withTempDir("baro-scope-", async (root) => {
            polyglot(root)
            assert.deepEqual([...affectedEcosystems(["README.md", "docs/x.png", ".gitignore"], root) as Set<string>], [])
            assert.equal(affectedEcosystems(["crates/tui/src/a.rs", "scripts/release.sh"], root), "all")
            assert.equal(affectedEcosystems(["config.yaml"], root), "all")
        })
    })
})

describe("scopeCommandsToChange", () => {
    it("drops the suites of ecosystems the change never touched", async () => {
        await withTempDir("baro-scope-", async (root) => {
            polyglot(root)
            const scoped = scopeCommandsToChange([cargoTest, nodeTest, npmBuild, hygiene], ["crates/tui/src/main.rs"], root, {})
            assert.deepEqual(scoped.run.map((c) => c.label), ["cargo test", "git diff --check"])
            assert.deepEqual(scoped.notAffected.map((c) => c.label), ["node --test (test)", "npm run build"])
        })
    })

    it("runs everything rather than leave the gate with no suite at all", async () => {
        await withTempDir("baro-scope-", async (root) => {
            polyglot(root)
            const docsOnly = scopeCommandsToChange([cargoTest, nodeTest, hygiene], ["NOTES.txt"], root, {})
            assert.equal(docsOnly.run.length, 3)
            assert.equal(docsOnly.notAffected.length, 0)
        })
    })

    it("always runs what a story declared and what it cannot classify", async () => {
        await withTempDir("baro-scope-", async (root) => {
            polyglot(root)
            const scoped = scopeCommandsToChange([cargoTest, nodeTest, declaredJs, hygiene], ["crates/tui/src/a.rs"], root, {})
            assert.deepEqual(scoped.run.map((c) => c.label), ["cargo test", "declared", "git diff --check"])
        })
    })

    it("scopes nothing without a readable diff, with an empty one, or when turned off", async () => {
        await withTempDir("baro-scope-", async (root) => {
            polyglot(root)
            const all = [cargoTest, nodeTest]
            assert.equal(scopeCommandsToChange(all, null, root, {}).run.length, 2)
            assert.equal(scopeCommandsToChange(all, [], root, {}).run.length, 2)
            assert.equal(
                scopeCommandsToChange(all, ["crates/tui/src/a.rs"], root, { BARO_VERIFY_SCOPE: "0" }).run.length,
                2,
            )
        })
    })
})

// #286: a six-file change in one package built, type-checked and tested all four.
describe("scopeCommandsToChange within a JavaScript workspace", () => {
    function workspace(root: string): Record<"core" | "app" | "site" | "lint", VerifyCommandSpec> {
        writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }))
        const pkg = (dir: string, manifest: Record<string, unknown>): void => {
            mkdirSync(join(root, "packages", dir, "src"), { recursive: true })
            writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(manifest))
        }
        pkg("core", { name: "@t/core" })
        pkg("app", { name: "@t/app", dependencies: { "@t/core": "*" } })
        pkg("site", { name: "@t/site", devDependencies: { left: "1.0.0" } })
        const test = (dir: string): VerifyCommandSpec => ({
            label: `npm run test (packages/${dir})`,
            tool: "npm",
            args: ["run", "test"],
            cwd: join(root, "packages", dir),
        })
        return {
            core: test("core"),
            app: test("app"),
            site: test("site"),
            lint: { label: "npm run lint", tool: "npm", args: ["run", "lint"] },
        }
    }
    const labels = (commands: readonly VerifyCommandSpec[]): string[] => commands.map((c) => c.label)

    it("runs the changed package and leaves the others out", async () => {
        await withTempDir("baro-scope-pkg-", async (root) => {
            const { core, app, site, lint } = workspace(root)
            const scoped = scopeCommandsToChange([core, app, site, lint], ["packages/app/src/a.ts"], root, {}, { byPackage: true })
            assert.deepEqual(labels(scoped.run), ["npm run test (packages/app)", "npm run lint"])
            assert.deepEqual(labels(scoped.notAffected), ["npm run test (packages/core)", "npm run test (packages/site)"])
        })
    })

    it("also runs every package that depends on the changed one", async () => {
        await withTempDir("baro-scope-pkg-", async (root) => {
            const { core, app, site, lint } = workspace(root)
            const scoped = scopeCommandsToChange([core, app, site, lint], ["packages/core/src/a.ts"], root, {}, { byPackage: true })
            assert.deepEqual(labels(scoped.run), [
                "npm run test (packages/core)",
                "npm run test (packages/app)",
                "npm run lint",
            ])
            assert.deepEqual(labels(scoped.notAffected), ["npm run test (packages/site)"])
        })
    })

    it("runs every package for a change outside all of them", async () => {
        await withTempDir("baro-scope-pkg-", async (root) => {
            const { core, app, site, lint } = workspace(root)
            for (const shared of ["package-lock.json", "tsconfig.base.json", "package.json"]) {
                const scoped = scopeCommandsToChange([core, app, site, lint], ["packages/app/src/a.ts", shared], root, {}, { byPackage: true })
                assert.deepEqual(scoped.notAffected, [], shared)
            }
        })
    })

    it("scopes nothing when a package manifest cannot be read, or a command is not in a known package", async () => {
        await withTempDir("baro-scope-pkg-", async (root) => {
            const { core, app, site, lint } = workspace(root)
            const stray: VerifyCommandSpec = { ...site, label: "stray", cwd: "/elsewhere/packages/site" }
            assert.deepEqual(
                labels(scopeCommandsToChange([core, stray, lint], ["packages/app/src/a.ts"], root, {}, { byPackage: true }).run),
                ["stray", "npm run lint"],
            )

            writeFileSync(join(root, "packages", "site", "package.json"), "{ not json")
            assert.deepEqual(
                scopeCommandsToChange([core, app, site, lint], ["packages/app/src/a.ts"], root, {}, { byPackage: true }).notAffected,
                [],
            )
        })
    })
    it("leaves the packages alone unless asked: a run-level gate checks the whole ecosystem", async () => {
        await withTempDir("baro-scope-pkg-", async (root) => {
            const { core, app, site, lint } = workspace(root)
            assert.deepEqual(
                scopeCommandsToChange([core, app, site, lint], ["packages/app/src/a.ts"], root, {}).notAffected,
                [],
            )
        })
    })
})

describe("verifyBuild scoped to a change", () => {
    it("runs only the commands of what changed since the base commit", async () => {
        await withTempDir("baro-scope-git-", async (root) => {
            polyglot(root)
            const git = (...args: string[]) =>
                execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }).trim()
            git("init", "-q", "-b", "main")
            git("add", ".")
            git("commit", "-q", "-m", "base")
            const base = git("rev-parse", "HEAD")
            writeFileSync(join(root, "crates", "tui", "src", "main.rs"), "fn main() {}\n")
            git("add", ".")
            git("commit", "-q", "-m", "rust only")
            // Untracked changes count too.
            writeFileSync(join(root, "crates", "tui", "src", "extra.rs"), "\n")
            assert.deepEqual(changedPathsSince(root, base)?.sort(), ["crates/tui/src/extra.rs", "crates/tui/src/main.rs"])

            // Whether cargo is installed or not, its result is listed; the failing JS suite must not run.
            const plan: VerifyPlan = {
                commands: [
                    { label: "rust gate", tool: "cargo", args: ["--version"] },
                    { label: "node --test (test)", tool: "node", args: ["-e", "process.exit(1)"] },
                ],
            }
            const activity: string[] = []
            const result = await verifyBuild(root, {
                plan,
                changedSince: base,
                refreshDependencies: false,
                emitActivity: (event) => {
                    if (event.type === "activity") activity.push(event.text)
                },
            })
            assert.deepEqual(result.commands.map((c) => c.command), ["rust gate"])
            assert.ok(result.ok, JSON.stringify(result.failures))
            assert.ok(activity.some((line) => /not run.*node --test \(test\)/u.test(line)), activity.join("\n"))
        })
    })
})
