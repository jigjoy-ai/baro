import { execFileSync } from "node:child_process"
import {
    chmodSync,
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
import { setTimeout as delay } from "node:timers/promises"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { type Tool } from "../src/runtime/mozaik.js"

import { createStoryTools } from "../src/planning/story-tools.js"

function namedTool(tools: Tool[], name: string): Tool {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.ok(tool, `missing ${name} tool`)
    return tool
}

async function invoke(tool: Tool, args: Record<string, unknown>): Promise<string> {
    return String(await tool.invoke(args))
}

type SignalAwareTool = Tool & {
    invokeWithSignal(
        args: Record<string, unknown>,
        signal: AbortSignal,
    ): Promise<unknown>
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(path)) {
        if (Date.now() >= deadline) assert.fail(`fixture did not create ${path}`)
        await delay(10)
    }
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`test operation timed out after ${timeoutMs}ms`)),
                    timeoutMs,
                )
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (processIsAlive(pid)) {
        if (Date.now() >= deadline) {
            assert.fail(`fixture process ${pid} survived bash tool settlement`)
        }
        await delay(10)
    }
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

async function withPortableShellGuard<T>(fn: () => Promise<T>): Promise<T> {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    assert.ok(platform)
    Object.defineProperty(process, "platform", {
        ...platform,
        value: "linux",
    })
    try {
        return await fn()
    } finally {
        Object.defineProperty(process, "platform", platform)
    }
}

async function withManagerDependencyLink(
    fn: (fixture: {
        origin: string
        story: string
        dependencyRoot: string
    }) => Promise<void>,
): Promise<void> {
    const base = mkdtempSync(join(tmpdir(), "baro-sandbox-dependency-link-"))
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
        execFileSync("git", ["worktree", "add", "-b", "story-deps", story], {
            cwd: origin,
            stdio: "ignore",
        })
        const dependencyRoot = join(origin, "node_modules")
        mkdirSync(join(dependencyRoot, "fixture"), { recursive: true })
        writeFileSync(join(dependencyRoot, "fixture", "index.js"), "dependency-ok\n")
        symlinkSync(dependencyRoot, join(story, "node_modules"), "dir")

        await fn({ origin, story, dependencyRoot })
    } finally {
        rmSync(base, { recursive: true, force: true })
    }
}

describe("Story tool project containment", () => {
    it(
        "drains an inherited-stdio process tree and removes its sandbox before abort settles",
        { skip: process.platform === "win32" },
        async () => {
            await withProjectAndSibling(async (project) => {
                const started = join(project, "bash-descendant-started")
                const escaped = join(project, "bash-descendant-escaped")
                const fixture = join(project, "bash-tree-fixture.mjs")
                const descendantSource = `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(
    ${JSON.stringify(started)},
    String(process.pid) + "\\n" + String(process.env.TMPDIR ?? ""),
);
setTimeout(() => {
    writeFileSync(${JSON.stringify(escaped)}, "yes");
    process.exit(0);
}, 12_000);
setInterval(() => {}, 10_000);
`
                writeFileSync(
                    fixture,
                    `#!/usr/bin/env node
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
const descendant = spawn(
    process.execPath,
    ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}],
    { stdio: ["ignore", "inherit", "inherit"] },
);
descendant.unref();
setTimeout(() => process.exit(0), 12_000);
setInterval(() => {}, 10_000);
`,
                )
                chmodSync(fixture, 0o755)
                const bash = namedTool(
                    createStoryTools(project),
                    "bash",
                ) as SignalAwareTool
                const controller = new AbortController()
                const pending = Promise.resolve(
                    bash.invokeWithSignal(
                        { command: "./bash-tree-fixture.mjs" },
                        controller.signal,
                    ),
                ).then(String)

                await waitForFile(started)
                controller.abort(new Error("cancel bash fixture"))
                const result = await within(pending, 9_000)

                assert.match(result, /^bash exited with status \?: .*aborted/m)
                const [pidText, scratch = ""] = readFileSync(started, "utf8")
                    .trimEnd()
                    .split("\n")
                const descendantPid = Number(pidText)
                assert.equal(Number.isSafeInteger(descendantPid), true)
                await waitForProcessExit(descendantPid)
                assert.equal(
                    existsSync(escaped),
                    false,
                    "bash tool settled before its descendant was killed",
                )
                if (
                    process.platform === "darwin" &&
                    existsSync("/usr/bin/sandbox-exec")
                ) {
                    assert.match(scratch, /baro-story-shell-/)
                    assert.equal(
                        existsSync(scratch),
                        false,
                        "bash tool settled before removing its Seatbelt scratch",
                    )
                }
            })
        },
    )

    it("strips provider secrets and rejects environment-dump commands", async () => {
        await withProjectAndSibling(async (project) => {
            const previous = process.env.OPENAI_API_KEY
            const secret = "sk-baro-shell-sentinel-123456"
            process.env.OPENAI_API_KEY = secret
            try {
                const probe = join(project, "show-provider-env.sh")
                writeFileSync(
                    probe,
                    "#!/bin/sh\nprintf '%s' \"$OPENAI_API_KEY\"\n",
                )
                chmodSync(probe, 0o755)
                const bash = namedTool(createStoryTools(project), "bash")
                const expanded = await invoke(bash, {
                    command: "./show-provider-env.sh",
                })
                const dumped = await invoke(bash, { command: "printenv" })

                assert.equal(expanded, "(empty output)")
                assert.match(dumped, /rejected by project containment guard/)
                assert.doesNotMatch(expanded + dumped, new RegExp(secret))
            } finally {
                if (previous === undefined) delete process.env.OPENAI_API_KEY
                else process.env.OPENAI_API_KEY = previous
            }
        })
    })

    it("allows only /dev/null as an external redirection sink", async () => {
        await withProjectAndSibling(async (project) => {
            const bash = namedTool(createStoryTools(project), "bash")

            const allowed = await invoke(bash, {
                command:
                    "cat definitely-missing 2>/dev/null || " +
                    "printf 'fallback:%s\\n' $?",
            })
            const denied = await invoke(bash, {
                command: "printf unsafe >/dev/zero",
            })

            assert.match(allowed, /fallback:/)
            assert.doesNotMatch(allowed, /containment guard/)
            assert.match(denied, /rejected by project containment guard/)
        })
    })

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
                    "commit -m 'document node_modules/pkg and ../example as text'",
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

    it("allows explicit dependency reads only under Seatbelt and never trusts the real path", async () => {
        await withManagerDependencyLink(async ({ origin, story, dependencyRoot }) => {
            mkdirSync(join(story, "untrusted"))
            symlinkSync(join(origin, ".git"), join(story, "untrusted", "vendor"), "dir")

            const bash = namedTool(createStoryTools(story), "bash")
            const throughLink = await invoke(bash, {
                command: "cat node_modules/fixture/index.js 2>/dev/null",
            })
            const directTarget = await invoke(bash, {
                command: `cat ${JSON.stringify(join(dependencyRoot, "fixture", "index.js"))}`,
            })
            const sameNamedUntrustedLink = await invoke(bash, {
                command: "cat untrusted/vendor/config",
            })

            if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
                assert.equal(throughLink, "dependency-ok\n")
            } else {
                assert.match(throughLink, /rejected by project containment guard/)
            }
            assert.match(directTarget, /rejected by project containment guard/)
            assert.match(sameNamedUntrustedLink, /rejected by project containment guard/)
        })
    })

    it("rejects explicit writes through a manager-owned dependency link on every platform", async () => {
        await withManagerDependencyLink(async ({ story, dependencyRoot }) => {
            const dependencyFile = join(dependencyRoot, "fixture", "index.js")
            const bash = namedTool(createStoryTools(story), "bash")
            const write = await invoke(bash, {
                command:
                    "printf 'story-mutation\\n' > " +
                    "node_modules/fixture/index.js",
            })

            assert.match(write, /rejected by project containment guard/)
            assert.equal(readFileSync(dependencyFile, "utf8"), "dependency-ok\n")
        })
    })

    it("trusts only the exact collaboration helper and gives no session write exception", async () => {
        await withProjectAndSibling(async (project, sibling) => {
            const commandPath = join(sibling, "agent-collab-fixture.mjs")
            const managerPrivateDir = join(sibling, "collective-session")
            mkdirSync(managerPrivateDir, { recursive: true })
            writeFileSync(
                commandPath,
                "process.stdout.write(process.argv.slice(2).join(' '))\n",
            )
            const endpoint = "http://127.0.0.1:4242"
            const token = "a".repeat(43)
            const bash = namedTool(
                createStoryTools(project, {
                    collaboration: { commandPath, endpoint, token },
                }),
                "bash",
            )

            const helperInvocation = await invoke(bash, {
                command:
                    `node ${JSON.stringify(commandPath)} inbox ` +
                    `--endpoint ${JSON.stringify(endpoint)} ` +
                    `--token ${JSON.stringify(token)}`,
            })
            const helperOutsideInvocation = await invoke(bash, {
                command: `cat ${JSON.stringify(commandPath)}`,
            })
            const managerPathOperand = await invoke(bash, {
                command:
                    `node ${JSON.stringify(commandPath)} inbox ` +
                    `--endpoint ${JSON.stringify(endpoint)} ` +
                    `--token ${JSON.stringify(token)} ` +
                    `--session ${JSON.stringify(managerPrivateDir)}`,
            })
            const unauthorizedManagerWrite =
                process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")
                    ? await invoke(bash, {
                          command:
                              `${JSON.stringify(process.execPath)} -e ` +
                              JSON.stringify(
                                  `require("node:fs").writeFileSync(` +
                                      `${JSON.stringify(join(managerPrivateDir, "hijack"))}, ` +
                                      `"unsafe")`,
                              ),
                      })
                    : null

            assert.equal(
                helperInvocation,
                `inbox --endpoint ${endpoint} --token ${token}`,
            )
            assert.match(helperOutsideInvocation, /rejected by project containment guard/)
            assert.match(managerPathOperand, /rejected by project containment guard/)
            if (unauthorizedManagerWrite !== null) {
                assert.match(unauthorizedManagerWrite, /Operation not permitted|EPERM/)
                assert.equal(existsSync(join(managerPrivateDir, "hijack")), false)
            }
        })
    })

    it("treats node inline code as data while Seatbelt still blocks external writes", {
        skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"),
    }, async () => {
        await withProjectAndSibling(async (project, sibling) => {
            const escapedWrite = join(sibling, "node-e-escape.txt")
            const bash = namedTool(createStoryTools(project), "bash")
            const harmless = await invoke(bash, {
                command:
                    `${JSON.stringify(process.execPath)} -e ` +
                    JSON.stringify(
                        `const long = ${JSON.stringify("x".repeat(300) + "/file")}; ` +
                            `console.log(long.length > 0 ? "inline-ok" : "bad")`,
                    ),
            })
            const compactFlagCommands = [
                `${JSON.stringify(process.execPath)} -e${JSON.stringify("x=../opaque")}`,
                `${JSON.stringify(process.execPath)} -p${JSON.stringify("x=../opaque")}`,
                `${JSON.stringify(process.execPath)} -pe ${JSON.stringify("x=../opaque")}`,
                `${JSON.stringify(process.execPath)} -pe${JSON.stringify("x=../opaque")}`,
                `${JSON.stringify(process.execPath)} -ep ${JSON.stringify("x=../opaque")}`,
                `${JSON.stringify(process.execPath)} -ep${JSON.stringify("x=../opaque")}`,
            ]
            const compactFlagResults: string[] = []
            for (const command of compactFlagCommands) {
                compactFlagResults.push(await invoke(bash, { command }))
            }
            const escaped = await invoke(bash, {
                command:
                    `${JSON.stringify(process.execPath)} -e ` +
                    JSON.stringify(
                        `require("node:fs").writeFileSync(` +
                            `${JSON.stringify(escapedWrite)}, "unsafe")`,
                    ),
            })

            assert.match(harmless, /inline-ok/)
            assert.doesNotMatch(harmless, /containment guard/)
            for (const result of compactFlagResults) {
                assert.doesNotMatch(result, /containment guard/)
            }
            assert.match(escaped, /Operation not permitted|EPERM/)
            assert.equal(existsSync(escapedWrite), false)
        })
    })

    it("rejects node -e/-p inline code without a process write sandbox", async () => {
        await withPortableShellGuard(async () => {
            await withProjectAndSibling(async (project) => {
                const bash = namedTool(createStoryTools(project), "bash")
                const commands = [
                    `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('no')")}`,
                    `${JSON.stringify(process.execPath)} -p ${JSON.stringify("1 + 1")}`,
                    `${JSON.stringify(process.execPath)} -e${JSON.stringify("x=../opaque")}`,
                    `${JSON.stringify(process.execPath)} -p${JSON.stringify("x=../opaque")}`,
                    `${JSON.stringify(process.execPath)} -pe ${JSON.stringify("x=../opaque")}`,
                    `${JSON.stringify(process.execPath)} -pe${JSON.stringify("x=../opaque")}`,
                    `${JSON.stringify(process.execPath)} -ep ${JSON.stringify("x=../opaque")}`,
                    `${JSON.stringify(process.execPath)} -ep${JSON.stringify("x=../opaque")}`,
                    `${JSON.stringify(process.execPath)} --eval=${JSON.stringify("console.log('no')")}`,
                    `${JSON.stringify(process.execPath)} --print=${JSON.stringify("1 + 1")}`,
                ]

                for (const command of commands) {
                    const result = await invoke(bash, { command })
                    assert.match(result, /rejected by project containment guard/)
                    assert.match(result, /node inline code flags require the macOS write sandbox/)
                }
            })
        })
    })

    it("rejects opaque Python, Perl, and Ruby evaluators without banning normal interpreter commands", async () => {
        await withPortableShellGuard(async () => {
            await withProjectAndSibling(async (project) => {
                const bash = namedTool(createStoryTools(project), "bash")
                const rejected: Array<readonly [string, RegExp]> = [
                    [`python -c ${JSON.stringify("print('../escape')")}`, /python/],
                    [`python3 -c${JSON.stringify("print('../escape')")}`, /python/],
                    [`python3.12 -Bc ${JSON.stringify("print('../escape')")}`, /python/],
                    [`python3 -xc ${JSON.stringify("print('../escape')")}`, /python/],
                    [`pypy3 -c ${JSON.stringify("print('../escape')")}`, /python/],
                    [`py -c ${JSON.stringify("print('../escape')")}`, /python/],
                    [`perl -e ${JSON.stringify("print '../escape'")}`, /perl/],
                    [`perl -e${JSON.stringify("print '../escape'")}`, /perl/],
                    [`perl -we ${JSON.stringify("print '../escape'")}`, /perl/],
                    [`perl -se ${JSON.stringify("print '../escape'")}`, /perl/],
                    [`perl -0e ${JSON.stringify("print '../escape'")}`, /perl/],
                    [`perl -0777e ${JSON.stringify("print '../escape'")}`, /perl/],
                    [`perl -de ${JSON.stringify("print '../escape'")}`, /perl/],
                    [`perl -Ve ${JSON.stringify("print '../escape'")}`, /perl/],
                    [`perl -E ${JSON.stringify("say '../escape'")}`, /perl/],
                    [`ruby -e ${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -e${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -we ${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -ve ${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -0e ${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -0777e ${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -We ${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -W0e ${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -Kue ${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -K-e ${JSON.stringify("puts '../escape'")}`, /ruby/],
                    [`ruby -T0e ${JSON.stringify("puts '../escape'")}`, /ruby/],
                ]

                for (const [command, interpreter] of rejected) {
                    const result = await invoke(bash, { command })
                    assert.match(result, /rejected by project containment guard/, command)
                    assert.match(result, interpreter, command)
                    assert.match(result, /require the macOS write sandbox/, command)
                }

                for (const command of [
                    "python3 --version",
                    "python3 -Wonce --version",
                    "python3 -Xtracemalloc --version",
                    "perl --version",
                    "perl -Ivendor --version",
                    "perl -MDevel::Peek --version",
                    "perl -0x0A --version",
                    "perl -d:Trace --version",
                    "perl -V:version",
                    "perl -Ce --version",
                    "ruby --version",
                    "ruby -Ivendor --version",
                    "ruby -rset --version",
                    "ruby -W:error --version",
                    "ruby -Ke --version",
                    "ruby -Eutf-8 --version",
                ]) {
                    const result = await invoke(bash, { command })
                    assert.doesNotMatch(result, /project containment guard/, command)
                }
            })
        })
    })

    it("rejects shell wrappers that can hide an opaque evaluator", async () => {
        await withPortableShellGuard(async () => {
            await withProjectAndSibling(async (project) => {
                const bash = namedTool(createStoryTools(project), "bash")
                const inline = JSON.stringify("print('../escape')")
                const commands = [
                    `command python3 -c ${inline}`,
                    `builtin command python3 -c ${inline}`,
                    `nohup python3 -c ${inline}`,
                    `nice python3 -c ${inline}`,
                    `time python3 -c ${inline}`,
                    `printf x | xargs -n1 python3 -c ${inline}`,
                ]

                for (const command of commands) {
                    const result = await invoke(bash, { command })
                    assert.match(result, /rejected by project containment guard/, command)
                    assert.match(result, /indirect shell command/, command)
                }
            })
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
