import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"

import type { VerifyCommandSpec } from "./verify.js"

export interface JvmToolchainProbe {
    readonly platform?: NodeJS.Platform
    readonly env?: NodeJS.ProcessEnv
    /** Injected by tests; the default really starts `java -version`. */
    readonly javaRuns?: (env: NodeJS.ProcessEnv) => boolean
}

/**
 * Run-level gates for a Maven or Gradle repository (#210): the merged result
 * of a Java project was verified by `git diff --check` alone.
 *
 * A command is offered only when its toolchain resolves on this host. A missing
 * tool otherwise reads as a skipped gate, which ends the run incomplete, and a
 * host with no JDK (stories there fetch their own into scratch) would lose
 * runs that complete today. Such a run stays reported as not verified.
 */
export function detectJvmCommands(
    cwd: string,
    probe: JvmToolchainProbe = {},
): VerifyCommandSpec[] {
    const platform = probe.platform ?? process.platform
    const env = probe.env ?? process.env
    const windows = platform === "win32"
    const hasBuildFile = [...MAVEN_FILES, ...GRADLE_FILES].some((name) =>
        existsSync(join(cwd, name)),
    )
    if (!hasBuildFile) return []
    if (!(probe.javaRuns ?? javaRuns)(env)) return []

    const commands: VerifyCommandSpec[] = []
    if (MAVEN_FILES.some((name) => existsSync(join(cwd, name)))) {
        const tool = wrapperOrTool(cwd, windows ? "mvnw.cmd" : "mvnw", "mvn", env, windows)
        if (tool) {
            commands.push({ label: "mvn test", tool, args: ["-B", "test"] })
        }
    }
    if (GRADLE_FILES.some((name) => existsSync(join(cwd, name)))) {
        const tool = wrapperOrTool(cwd, windows ? "gradlew.bat" : "gradlew", "gradle", env, windows)
        if (tool) {
            commands.push({
                label: "gradle test",
                tool,
                args: ["test", "--console=plain"],
            })
        }
    }
    return commands
}

const MAVEN_FILES = ["pom.xml"]
const GRADLE_FILES = [
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
]

// A `java` on PATH is not a JDK: macOS ships a stub that only prints how to
// install one, and a wrapper run against it would fail the run outright.
function javaRuns(env: NodeJS.ProcessEnv): boolean {
    const java = env.JAVA_HOME ? join(env.JAVA_HOME, "bin", "java") : "java"
    try {
        return (
            spawnSync(java, ["-version"], {
                env,
                stdio: "ignore",
                timeout: 15_000,
            }).status === 0
        )
    } catch {
        return false
    }
}

/**
 * The executable for a declared `mvn …` / `gradle …` test, or null when this
 * host cannot run the build at all.
 */
export function resolveJvmBuildTool(
    cwd: string,
    kind: "maven" | "gradle",
    probe: JvmToolchainProbe = {},
): string | null {
    const env = probe.env ?? process.env
    const windows = (probe.platform ?? process.platform) === "win32"
    if (!(probe.javaRuns ?? javaRuns)(env)) return null
    return kind === "maven"
        ? wrapperOrTool(cwd, windows ? "mvnw.cmd" : "mvnw", "mvn", env, windows)
        : wrapperOrTool(cwd, windows ? "gradlew.bat" : "gradlew", "gradle", env, windows)
}

/**
 * Why the run verifier will skip a JVM gate on this host, or null. Said
 * before any story runs (#219): a story can fetch a JDK into its own scratch,
 * the verifier on the merged tree cannot.
 */
export function jvmToolchainGap(
    cwd: string,
    probe: JvmToolchainProbe = {},
): string | null {
    const builds = JVM_BUILDS.filter((build) => build.present(cwd))
    if (builds.length === 0) return null
    const env = probe.env ?? process.env
    let missing: string
    let skipped = builds
    if (!(probe.javaRuns ?? javaRuns)(env)) {
        missing = env.JAVA_HOME
            ? `no JDK runs from JAVA_HOME (${env.JAVA_HOME})`
            : "no JDK runs on this host (`java -version` failed)"
    } else {
        const jdk = { ...probe, javaRuns: () => true }
        skipped = builds.filter((build) => !resolveJvmBuildTool(cwd, build.kind, jdk))
        if (skipped.length === 0) return null
        missing = skipped.map((build) => build.noTool).join(" and ")
    }
    return (
        `${missing}, so the run verifier will skip ${skipped.map((build) => build.gate).join(" and ")}. ` +
        "Install the toolchain on the host (or set JAVA_HOME / commit the build wrapper) " +
        "for the merged result to be test-verified."
    )
}

const JVM_BUILDS = [
    {
        kind: "maven",
        present: isMavenRepository,
        gate: "`mvn test`",
        noTool: "neither ./mvnw nor `mvn` on PATH",
    },
    {
        kind: "gradle",
        present: isGradleRepository,
        gate: "`gradle test`",
        noTool: "neither ./gradlew nor `gradle` on PATH",
    },
] as const

export function isMavenRepository(cwd: string): boolean {
    return MAVEN_FILES.some((name) => existsSync(join(cwd, name)))
}

export function isGradleRepository(cwd: string): boolean {
    return GRADLE_FILES.some((name) => existsSync(join(cwd, name)))
}

// The repository's wrapper pins the build tool version, so it wins over PATH.
function wrapperOrTool(
    cwd: string,
    wrapper: string,
    tool: string,
    env: NodeJS.ProcessEnv,
    windows: boolean,
): string | null {
    if (isFile(join(cwd, wrapper))) return windows ? `.\\${wrapper}` : `./${wrapper}`
    return onPath(tool, env, windows) ? tool : null
}

function onPath(tool: string, env: NodeJS.ProcessEnv, windows: boolean): boolean {
    const dirs = (env.PATH ?? env.Path ?? "").split(windows ? ";" : delimiter)
    const names = windows
        ? [`${tool}.cmd`, `${tool}.bat`, `${tool}.exe`]
        : [tool]
    return dirs.some(
        (dir) =>
            dir.length > 0 &&
            names.some((name) => isExecutable(join(dir, name), windows)),
    )
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile()
    } catch {
        return false
    }
}

function isExecutable(path: string, windows: boolean): boolean {
    if (!isFile(path)) return false
    if (windows) return true
    try {
        accessSync(path, constants.X_OK)
        return true
    } catch {
        return false
    }
}
