import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Finds a Python that can run pytest for a verification, or makes one.
 *
 * Agents test Python work in venvs of their own (often under .baro-scratch,
 * which is excluded from integration), so the integrated tree usually has no
 * environment of its own and the host Python rarely has pytest. Verification
 * would then report every Python test as unrunnable. Order: the project's own
 * venv, a host Python that already has pytest, then a verifier-owned venv
 * outside the repository with pytest and the project's declared dependencies.
 */
export type PytestRunner =
    | { python: string; source: "project-venv" | "host" | "provisioned" }
    | { missing: string }

export interface PytestRunnerOptions {
    /** Where verifier-owned venvs live; defaults to the OS temp dir. */
    provisionRoot?: string
    /** Per step (venv creation, pip install). */
    timeoutMs?: number
}

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000

export async function resolvePytestRunner(
    cwd: string,
    options: PytestRunnerOptions = {},
): Promise<PytestRunner> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
    for (const python of projectVenvPythons(cwd)) {
        if (await hasPytest(python, cwd)) return { python, source: "project-venv" }
    }
    const hosts = ["python3", "python"]
    for (const python of hosts) {
        if (await hasPytest(python, cwd)) return { python, source: "host" }
    }
    let base: string | null = null
    for (const python of hosts) {
        if (await run(python, ["-c", "import sys, venv; assert sys.version_info >= (3, 8)"], cwd, 30_000)) {
            base = python
            break
        }
    }
    if (!base) {
        return {
            missing:
                "no Python 3.8+ on PATH to run pytest; install Python, or give the project a .venv with pytest",
        }
    }
    const venv = join(
        options.provisionRoot ?? join(tmpdir(), "baro-verify-python"),
        createHash("sha256").update(safeRealpath(cwd)).digest("hex").slice(0, 16),
    )
    const python = venvPython(venv)
    if (!existsSync(python)) {
        mkdirSync(venv, { recursive: true })
        if (!(await run(base, ["-m", "venv", venv], cwd, timeoutMs))) {
            return { missing: `could not create a verification venv with ${base} -m venv` }
        }
    }
    const requirements = ["requirements.txt", "requirements-dev.txt", "requirements-test.txt"]
        .filter((file) => existsSync(join(cwd, file)))
        .flatMap((file) => ["-r", file])
    const declared = await declaredDependencies(python, cwd)
    const installed = await run(
        python,
        [
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--quiet",
            "pytest",
            ...declared,
            ...requirements,
        ],
        cwd,
        timeoutMs,
    )
    if (!installed || !(await hasPytest(python, cwd))) {
        return {
            missing:
                "could not install pytest and the project's dependencies into a verification venv (pip install failed; check network access)",
        }
    }
    return { python, source: "provisioned" }
}

function projectVenvPythons(cwd: string): string[] {
    return [".venv", "venv"]
        .map((dir) => venvPython(join(cwd, dir)))
        .filter((python) => existsSync(python))
}

function venvPython(venv: string): string {
    return process.platform === "win32"
        ? join(venv, "Scripts", "python.exe")
        : join(venv, "bin", "python")
}

function hasPytest(python: string, cwd: string): Promise<boolean> {
    return run(python, ["-c", "import pytest"], cwd, 60_000)
}

/** [project] dependencies plus the conventional test/dev extras, when the
 * interpreter can read pyproject.toml (tomllib, Python 3.11+). */
async function declaredDependencies(python: string, cwd: string): Promise<string[]> {
    if (!existsSync(join(cwd, "pyproject.toml"))) return []
    const script = [
        "import json, tomllib",
        "p = tomllib.load(open('pyproject.toml', 'rb')).get('project', {})",
        "deps = list(p.get('dependencies', []))",
        "extra = p.get('optional-dependencies', {})",
        "[deps.extend(extra.get(k, [])) for k in ('test', 'tests', 'dev')]",
        "print(json.dumps([d for d in deps if isinstance(d, str)]))",
    ].join("\n")
    const out = await capture(python, ["-c", script], cwd)
    try {
        const parsed = JSON.parse(out ?? "[]")
        return Array.isArray(parsed) ? parsed.filter((d) => typeof d === "string") : []
    } catch {
        return []
    }
}

function run(command: string, args: string[], cwd: string, timeout: number): Promise<boolean> {
    return new Promise((resolveRun) => {
        execFile(command, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (error) =>
            resolveRun(!error),
        )
    })
}

function capture(command: string, args: string[], cwd: string): Promise<string | null> {
    return new Promise((resolveCapture) => {
        execFile(command, args, { cwd, timeout: 60_000 }, (error, stdout) =>
            resolveCapture(error ? null : String(stdout).trim()),
        )
    })
}

function safeRealpath(path: string): string {
    try {
        return realpathSync(path)
    } catch {
        return path
    }
}
