import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "@rstest/core"

import { resolvePytestRunner } from "../../src/verification/python-env.js"

const posix = process.platform !== "win32"

function script(path: string, body: string): void {
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
}

describe.skipIf(!posix)("resolvePytestRunner", () => {
    let dir: string
    let bin: string
    let savedPath: string | undefined

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "baro-pyenv-"))
        bin = join(dir, "bin")
        mkdirSync(bin)
        savedPath = process.env.PATH
        // Only the stubs below are on PATH, plus /bin for sh, mkdir and chmod.
        process.env.PATH = `${bin}:/bin`
    })

    afterEach(() => {
        process.env.PATH = savedPath
        rmSync(dir, { recursive: true, force: true })
    })

    it("uses the project's own .venv when it has pytest", async () => {
        const repo = join(dir, "repo")
        mkdirSync(join(repo, ".venv", "bin"), { recursive: true })
        script(join(repo, ".venv", "bin", "python"), "exit 0")

        const runner = await resolvePytestRunner(repo)

        assert.deepEqual(runner, { python: join(repo, ".venv", "bin", "python"), source: "project-venv" })
    })

    it("provisions a verifier-owned venv outside the repo when no Python has pytest", async () => {
        const repo = join(dir, "repo")
        mkdirSync(repo)
        writeFileSync(join(repo, "requirements.txt"), "requests\n")
        const log = join(dir, "pip.log")
        // Host python: no pytest, but can make a venv whose python records pip.
        script(
            join(bin, "python3"),
            [
                'case "$2" in "import pytest") exit 1;; esac',
                'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
                '  mkdir -p "$3/bin"',
                `  printf '#!/bin/sh\\nif [ "$2" = "pip" ]; then echo "$@" >> ${log}; fi\\ncase "$2" in *tomllib*) echo "[]";; esac\\nexit 0\\n' > "$3/bin/python"`,
                '  chmod +x "$3/bin/python"',
                "fi",
                "exit 0",
            ].join("\n"),
        )
        const provisionRoot = join(dir, "venvs")

        const runner = await resolvePytestRunner(repo, { provisionRoot })

        assert.ok("python" in runner && runner.source === "provisioned", JSON.stringify(runner))
        assert.ok(runner.python.startsWith(provisionRoot), "the venv lives outside the repository")
        assert.equal(existsSync(join(repo, ".venv")), false, "nothing is written into the repository")
        const pip = readFileSync(log, "utf8")
        assert.match(pip, /install .*pytest/)
        assert.match(pip, /-r requirements\.txt/)
    })

    it("reports a missing environment instead of pretending the tests ran", async () => {
        const repo = join(dir, "repo")
        mkdirSync(repo)
        // On Linux /bin is /usr/bin and holds the host's python3.
        process.env.PATH = bin

        const runner = await resolvePytestRunner(repo)

        assert.ok("missing" in runner)
        assert.match(runner.missing, /no Python 3\.8\+ on PATH/)
    })
})
