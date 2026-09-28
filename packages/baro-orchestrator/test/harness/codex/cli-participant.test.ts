import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { CodexCliParticipant } from "../../../src/harness/codex/cli-participant.js"
import {
    AgentState,
    CodexSystem,
    CodexTurnEvent,
} from "../../../src/semantic-events.js"
import {
    assertHarnessEnvironmentWasSanitized,
    captureEnv,
    harnessEnvironmentCaptureProgram,
    withInjectedJigJoyEnvironment,
    withTempDir,
} from "../../execution/helpers.js"

function writeFakeCodex(dir: string): string {
    const bin = join(dir, "fake-codex.mjs")
    const events = [
        {
            type: "thread.started",
            thread_id: "codex-thread-1",
        },
        {
            type: "turn.started",
        },
        {
            type: "turn.completed",
            usage: {
                input_tokens: 1,
                output_tokens: 1,
            },
        },
    ]

    writeFileSync(
        bin,
        `#!/usr/bin/env node\nconst events = ${JSON.stringify(events)};\nfor (const event of events) console.log(JSON.stringify(event));\n`,
    )
    chmodSync(bin, 0o755)
    return bin
}

function writeFakeCodexArgCapture(
    dir: string,
): { bin: string; argsPath: string; stdinPath: string } {
    const bin = join(dir, "fake-codex-args.mjs")
    const argsPath = join(dir, "args.json")
    const stdinPath = join(dir, "stdin.txt")

    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(stdinPath)}, stdin);
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-args" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } }));
`,
    )
    chmodSync(bin, 0o755)
    return { bin, argsPath, stdinPath }
}

function writeFakeCodexWithPostExitStdio(dir: string): string {
    const bin = join(dir, "fake-codex-final-line.mjs")
    const stdout = [
        JSON.stringify({
            type: "thread.started",
            thread_id: "final-line",
        }),
        JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 1, output_tokens: 1 },
        }),
    ].join("\n")
    writeFileSync(
        bin,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
const follower = spawn("/bin/sh", [
  "-c",
  "printf ready >&3; while kill -0 \\\"$1\\\" 2>/dev/null; do :; done; sleep 0.15; printf '%s' \\\"$2\\\"; printf '%s' \\\"$3\\\" >&2",
  "baro-stdio-follower",
  String(process.pid),
  ${JSON.stringify(stdout)},
  "codex terminal diagnostic",
], { stdio: ["ignore", "inherit", "inherit", "pipe"] });
follower.stdio[3].once("data", () => {
  follower.stdio[3].destroy();
  follower.unref();
  process.exit(0);
});
`,
    )
    chmodSync(bin, 0o755)
    return bin
}

function writeFakeCodexWithoutStart(dir: string): string {
    const bin = join(dir, "fake-codex-no-start.mjs")
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(7);\n")
    chmodSync(bin, 0o755)
    return bin
}

describe("CodexCliParticipant", () => {
    it("keeps Baro's injected Gateway credential out of the Codex subscription process", async () => {
        await withTempDir("baro-codex-cli-env-", async (dir) => {
            const capture = join(dir, "env.json")
            const bin = join(dir, "fake-codex-env.mjs")
            writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
${harnessEnvironmentCaptureProgram(capture)}
console.log(JSON.stringify({ type: "thread.started", thread_id: "env-thread" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`)
            chmodSync(bin, 0o755)

            await withInjectedJigJoyEnvironment(async () => {
                const participant = new CodexCliParticipant("codex-env", {
                    cwd: dir,
                    prompt: "verify env",
                    codexBin: bin,
                    skipGitRepoCheck: true,
                })
                participant.start(captureEnv())
                await participant.ready
                assert.equal((await participant.done).exitCode, 0)
            })
            assertHarnessEnvironmentWasSanitized(capture)
        })
    })

    it("maps fake JSONL output into lifecycle and turn events", async () => {
        await withTempDir("baro-codex-cli-", async (dir) => {
            const env = captureEnv()
            const participant = new CodexCliParticipant("codex-agent", {
                cwd: dir,
                prompt: "do the work",
                codexBin: writeFakeCodex(dir),
                skipGitRepoCheck: true,
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.threadId, "codex-thread-1")
            assert.equal(summary.error, null)
            assert.equal(participant.getPhase(), "done")

            assert.ok(
                env.events.some(
                    (event) =>
                        AgentState.is(event) &&
                        event.data.agentId === "codex-agent" &&
                        event.data.phase === "running",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        CodexSystem.is(event) &&
                        event.data.subtype === "thread.started",
                ),
            )
            assert.ok(
                env.events.some(
                    (event) =>
                        CodexTurnEvent.is(event) &&
                        event.data.phase === "completed",
                ),
            )
        })
    })

    it("passes configured command arguments to the fake Codex process", async () => {
        await withTempDir("baro-codex-cli-args-", async (dir) => {
            const { bin, argsPath, stdinPath } = writeFakeCodexArgCapture(dir)
            const env = captureEnv()
            const participant = new CodexCliParticipant("codex-agent", {
                cwd: dir,
                prompt: "do the configured work",
                codexBin: bin,
                skipGitRepoCheck: true,
                bypassSandbox: true,
                model: "gpt-test",
                extraArgs: ["--profile", "baro-test"],
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.threadId, "codex-thread-args")
            assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-test",
                "--profile",
                "baro-test",
                "-",
            ])
            assert.equal(readFileSync(stdinPath, "utf8"), "do the configured work")
        })
    })

    it("pipes a large story prompt over stdin so argv stays under Windows limits", async () => {
        await withTempDir("baro-codex-cli-stdin-", async (dir) => {
            const { bin, argsPath, stdinPath } = writeFakeCodexArgCapture(dir)
            const prompt = `story:${"x".repeat(200_000)}`
            const participant = new CodexCliParticipant("codex-agent", {
                cwd: dir,
                prompt,
                codexBin: bin,
                skipGitRepoCheck: true,
                bypassSandbox: true,
            })

            participant.start(captureEnv())
            await participant.ready
            assert.equal((await participant.done).exitCode, 0)

            const argv = JSON.parse(readFileSync(argsPath, "utf8")) as string[]
            assert.equal(argv.at(-1), "-")
            assert.ok(argv.join(" ").length < 1_024)
            assert.equal(readFileSync(stdinPath, "utf8"), prompt)
        })
    })

    it("waits for inherited stdio to flush final JSON and stderr after process exit", async () => {
        await withTempDir("baro-codex-cli-final-line-", async (dir) => {
            const env = captureEnv()
            const participant = new CodexCliParticipant("codex-agent", {
                cwd: dir,
                prompt: "finish",
                codexBin: writeFakeCodexWithPostExitStdio(dir),
                skipGitRepoCheck: true,
            })

            participant.start(env)
            await participant.ready
            const summary = await participant.done

            assert.equal(summary.exitCode, 0)
            assert.equal(summary.threadId, "final-line")
            assert.equal(summary.stderrTail, "codex terminal diagnostic")
            assert.ok(
                env.events.some(
                    (event) =>
                        CodexTurnEvent.is(event) &&
                        event.data.phase === "completed",
                ),
            )
        })
    })

    it("rejects ready instead of leaving it pending when the process exits before start", async () => {
        await withTempDir("baro-codex-cli-no-start-", async (dir) => {
            const participant = new CodexCliParticipant("codex-agent", {
                cwd: dir,
                prompt: "fail",
                codexBin: writeFakeCodexWithoutStart(dir),
                skipGitRepoCheck: true,
            })

            participant.start(captureEnv())
            await assert.rejects(participant.ready, /before thread\.started/)
            assert.equal((await participant.done).exitCode, 7)
        })
    })
})
