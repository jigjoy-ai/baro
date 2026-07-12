import { execFileSync } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { type Tool } from "@mozaik-ai/core"

import { createStoryTools } from "../src/planning/story-tools.js"

function namedTool(tools: Tool[], name: string): Tool {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.ok(tool, `missing ${name} tool`)
    return tool
}

async function invoke(tool: Tool, args: Record<string, unknown>): Promise<string> {
    return String(await tool.invoke(args))
}

async function withProjectAndSibling(
    fn: (project: string, sibling: string) => Promise<void>,
): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), "baro-tool-containment-"))
    const project = join(base, "repo")
    const sibling = join(base, "repo-evil")
    mkdirSync(project)
    mkdirSync(sibling)
    try {
        await fn(project, sibling)
    } finally {
        rmSync(base, { recursive: true, force: true })
    }
}

describe("Story tool project containment", () => {
    it("rejects sibling-prefix paths for reads and writes", async () => {
        await withProjectAndSibling(async (project, sibling) => {
            const secret = join(sibling, "secret.txt")
            const escapedWrite = join(sibling, "written.txt")
            writeFileSync(secret, "outside\n")
            const tools = createStoryTools(project)

            const read = await invoke(namedTool(tools, "read_file"), { path: secret })
            const write = await invoke(namedTool(tools, "write_file"), {
                path: escapedWrite,
                content: "must not escape\n",
            })

            assert.match(read, /escapes the project root/)
            assert.match(write, /escapes the project root/)
            assert.equal(existsSync(escapedWrite), false)
        })
    })

    it("rejects read, edit, and not-yet-created writes through escaping symlinks", async () => {
        await withProjectAndSibling(async (project, sibling) => {
            const outsideFile = join(sibling, "outside.txt")
            writeFileSync(outsideFile, "original\n")
            symlinkSync(outsideFile, join(project, "outside-file"))
            symlinkSync(sibling, join(project, "outside-dir"), "dir")
            const tools = createStoryTools(project)

            const read = await invoke(namedTool(tools, "read_file"), {
                path: "outside-file",
            })
            const edit = await invoke(namedTool(tools, "edit_file"), {
                path: "outside-file",
                old: "original",
                new: "escaped",
            })
            const write = await invoke(namedTool(tools, "write_file"), {
                path: "outside-dir/new.txt",
                content: "escaped\n",
            })

            assert.match(read, /escapes the project root/)
            assert.match(edit, /escapes the project root/)
            assert.match(write, /escapes the project root/)
            assert.equal(readFileSync(outsideFile, "utf8"), "original\n")
            assert.equal(existsSync(join(sibling, "new.txt")), false)
        })
    })

    it("rejects the recorded cd-outside/install escape before spawning bash", async () => {
        await withProjectAndSibling(async (project, sibling) => {
            writeFileSync(join(sibling, "package.json"), '{"name":"outside","private":true}\n')
            const bash = namedTool(createStoryTools(project), "bash")

            const result = await invoke(bash, {
                command: `cd ${JSON.stringify(sibling)} && npm install`,
            })

            assert.match(result, /rejected by project containment guard/)
            assert.match(result, /cd target|absolute path/)
            assert.equal(existsSync(join(sibling, "node_modules")), false)
            assert.equal(existsSync(join(sibling, "package-lock.json")), false)
        })
    })

    it(
        "uses the macOS process sandbox to block an indirect Node write to a sibling",
        { skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec") },
        async () => {
            await withProjectAndSibling(async (project, sibling) => {
                const escapedWrite = join(sibling, "indirect-node-write.txt")
                const script =
                    `require("node:fs").writeFileSync(` +
                    `${JSON.stringify(escapedWrite)}, "must not escape")`
                const bash = namedTool(createStoryTools(project), "bash")

                const result = await invoke(bash, {
                    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
                })

                assert.doesNotMatch(result, /project containment guard/)
                assert.match(result, /Operation not permitted|EPERM/)
                assert.equal(existsSync(escapedWrite), false)
            })
        },
    )

    it("rejects parent, home, external absolute, and symlink cd escapes", async () => {
        await withProjectAndSibling(async (project, sibling) => {
            symlinkSync(sibling, join(project, "outside-link"), "dir")
            const bash = namedTool(createStoryTools(project), "bash")
            const escapedOutput = join(sibling, "shell-write.txt")
            const commands = [
                "cd ../repo-evil && npm install",
                "cd ~/another-repo && npm install",
                "cat /etc/passwd",
                "find /Users -name package.json",
                "npm --prefix ../repo-evil install",
                "git -C /tmp status",
                "cd outside-link && npm install",
                `printf unsafe > ${JSON.stringify(escapedOutput)}`,
            ]

            for (const command of commands) {
                const result = await invoke(bash, { command })
                assert.match(result, /rejected by project containment guard/, command)
            }
            assert.equal(existsSync(escapedOutput), false)
        })
    })

    it("allows safe subdirectory builds, writes, and git commits", async () => {
        await withProjectAndSibling(async (project) => {
            const app = join(project, "packages", "app")
            mkdirSync(app, { recursive: true })
            writeFileSync(
                join(app, "package.json"),
                JSON.stringify({
                    name: "contained-app",
                    private: true,
                    scripts: { build: "node -e \"console.log('contained-build')\"" },
                }),
            )
            writeFileSync(join(project, "README.md"), "contained\n")
            const bash = namedTool(createStoryTools(project), "bash")

            const build = await invoke(bash, {
                command: "cd packages/app && npm run build",
            })
            const write = await invoke(bash, {
                command: "cd packages/app && printf 'safe-output\\n' > result.txt",
            })
            const commit = await invoke(bash, {
                command:
                    "git init && git add -A && " +
                    "git -c user.name=Baro -c user.email=baro@example.invalid " +
                    "commit -m 'contained commit'",
            })

            assert.match(build, /contained-build/)
            assert.equal(write, "(empty output)")
            assert.equal(readFileSync(join(app, "result.txt"), "utf8"), "safe-output\n")
            assert.doesNotThrow(() =>
                execFileSync("git", ["rev-parse", "HEAD"], { cwd: project }),
            )
            assert.doesNotMatch(commit, /containment guard/)
        })
    })

    it("allows a commit in a linked Git worktree without opening sibling writes", async () => {
        const base = mkdtempSync(join(tmpdir(), "baro-sandbox-worktree-"))
        const origin = join(base, "origin")
        const story = join(base, "story")
        try {
            mkdirSync(origin)
            execFileSync("git", ["init"], { cwd: origin, stdio: "ignore" })
            writeFileSync(join(origin, "README.md"), "base\n")
            execFileSync("git", ["add", "-A"], { cwd: origin })
            execFileSync(
                "git",
                [
                    "-c",
                    "user.name=Baro",
                    "-c",
                    "user.email=baro@example.invalid",
                    "commit",
                    "-m",
                    "base",
                ],
                { cwd: origin, stdio: "ignore" },
            )
            execFileSync("git", ["worktree", "add", "-b", "story-branch", story], {
                cwd: origin,
                stdio: "ignore",
            })

            const bash = namedTool(createStoryTools(story), "bash")
            const result = await invoke(bash, {
                command:
                    "printf 'story change\\n' > story.txt && git add -A && " +
                    "git -c user.name=Baro -c user.email=baro@example.invalid " +
                    "commit -m 'story commit'",
            })

            assert.doesNotMatch(result, /Operation not permitted|containment guard/)
            assert.equal(
                execFileSync("git", ["show", "HEAD:story.txt"], {
                    cwd: story,
                    encoding: "utf8",
                }),
                "story change\n",
            )
        } finally {
            rmSync(base, { recursive: true, force: true })
        }
    })

    it("keeps a similarly named sibling distinguishable in diagnostics", async () => {
        await withProjectAndSibling(async (project, sibling) => {
            const bash = namedTool(createStoryTools(project), "bash")
            const result = await invoke(bash, { command: `cat ${JSON.stringify(sibling)}` })

            assert.match(result, /absolute path/)
            assert.match(result, new RegExp(basename(sibling)))
        })
    })
})
