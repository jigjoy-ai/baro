import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { detectJvmCommands } from "../../src/verification/jvm-commands.js"
import { createVerifyPlan, verifyBuild } from "../../src/verification/verify.js"
import { withTempDir } from "../execution/helpers.js"

function executable(dir: string, name: string): void {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, "#!/bin/sh\nexit 0\n")
    chmodSync(path, 0o755)
}

const summary = (commands: ReturnType<typeof detectJvmCommands>) =>
    commands.map(({ label, tool, args }) => ({ label, tool, args }))

describe("detectJvmCommands (#210)", () => {
    it("offers mvn test for a Maven repository when mvn and a JDK are present", async () => {
        await withTempDir("baro-jvm-", async (root) => {
            const repo = join(root, "repo")
            const bin = join(root, "bin")
            mkdirSync(repo)
            writeFileSync(join(repo, "pom.xml"), "<project/>")
            executable(bin, "mvn")

            const commands = detectJvmCommands(repo, {
                platform: "linux",
                env: { PATH: bin },
                javaRuns: () => true,
            })

            assert.deepEqual(summary(commands), [
                { label: "mvn test", tool: "mvn", args: ["-B", "test"] },
            ])
        })
    })

    it("prefers the repository's wrapper over PATH", async () => {
        await withTempDir("baro-jvm-", async (root) => {
            writeFileSync(join(root, "build.gradle.kts"), "")
            executable(root, "gradlew")

            const commands = detectJvmCommands(root, {
                platform: "linux",
                env: { PATH: "" },
                javaRuns: () => true,
            })

            assert.deepEqual(summary(commands), [
                { label: "gradle test", tool: "./gradlew", args: ["test", "--console=plain"] },
            ])
        })
    })

    it("offers nothing when the host cannot run the build", async () => {
        await withTempDir("baro-jvm-", async (root) => {
            const bin = join(root, "bin")
            writeFileSync(join(root, "pom.xml"), "<project/>")
            executable(root, "mvnw")
            executable(bin, "mvn")

            // No working JDK: a wrapper or mvn would only fail the run.
            assert.deepEqual(
                detectJvmCommands(root, {
                    platform: "linux",
                    env: { PATH: bin },
                    javaRuns: () => false,
                }),
                [],
            )
            // A JDK but neither wrapper nor build tool for Gradle.
            writeFileSync(join(root, "settings.gradle"), "")
            assert.deepEqual(
                summary(
                    detectJvmCommands(root, {
                        platform: "linux",
                        env: { PATH: "" },
                        javaRuns: () => true,
                    }),
                ),
                [{ label: "mvn test", tool: "./mvnw", args: ["-B", "test"] }],
            )
        })
    })

    it("runs the detected Maven gate as run-level verification", async () => {
        await withTempDir("baro-jvm-", async (root) => {
            const repo = join(root, "repo")
            const bin = join(root, "bin")
            mkdirSync(repo)
            writeFileSync(join(repo, "pom.xml"), "<project/>")
            executable(bin, "mvn")
            executable(bin, "java")
            const saved = { PATH: process.env.PATH, JAVA_HOME: process.env.JAVA_HOME }
            process.env.PATH = `${bin}:${saved.PATH ?? ""}`
            delete process.env.JAVA_HOME
            try {
                const result = await verifyBuild(repo, { plan: createVerifyPlan(repo) })
                assert.equal(result.ok, true)
                assert.deepEqual(
                    result.commands.map(({ command, status }) => ({ command, status })),
                    [{ command: "mvn test", status: "passed" }],
                )
            } finally {
                process.env.PATH = saved.PATH
                if (saved.JAVA_HOME !== undefined) process.env.JAVA_HOME = saved.JAVA_HOME
            }
        })
    })

    it("never probes for a JDK in a repository that is not a JVM build", async () => {
        await withTempDir("baro-jvm-", async (root) => {
            let probed = false
            const commands = detectJvmCommands(root, {
                javaRuns: () => {
                    probed = true
                    return true
                },
            })
            assert.deepEqual(commands, [])
            assert.equal(probed, false)
        })
    })
})
