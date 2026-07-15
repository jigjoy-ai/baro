import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { promisify } from "node:util"

const exec = promisify(execFile)
const CLI = join(import.meta.dirname, "..", "scripts", "cli.ts")

async function runCli(
    args: string[],
    environment: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stderr: string }> {
    try {
        const result = await exec(
            process.execPath,
            ["--import", "tsx", CLI, ...args],
            { timeout: 30_000, env: environment },
        )
        return { code: 0, stderr: result.stderr }
    } catch (error) {
        const failure = error as { code?: number; stderr?: string }
        return {
            code: failure.code ?? -1,
            stderr: failure.stderr ?? "",
        }
    }
}

describe("conversation context CLI seam", () => {
    it("loads only the strict bounded context from an explicit file flag", async () => {
        const dir = fixtureDirectory()
        try {
            const result = await runCli([
                "--cwd", dir,
                "--prd", "prd.json",
                "--conversation-context-file", "invalid-context.json",
            ])
            assert.equal(result.code, 2)
            assert.match(result.stderr, /invalid conversation context file/)
            assert.match(result.stderr, /exact v1 schema/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it("supports the ephemeral file path through BARO_CONVERSATION_CONTEXT_FILE", async () => {
        const dir = fixtureDirectory()
        try {
            const result = await runCli(
                ["--cwd", dir, "--prd", "prd.json"],
                {
                    ...process.env,
                    BARO_CONVERSATION_CONTEXT_FILE: "invalid-context.json",
                },
            )
            assert.equal(result.code, 2)
            assert.match(result.stderr, /invalid conversation context file/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

function fixtureDirectory(): string {
    const dir = mkdtempSync(join(tmpdir(), "baro-context-cli-"))
    writeFileSync(join(dir, "prd.json"), JSON.stringify({
        project: "context-cli-test",
        branchName: "baro/context-cli-test",
        description: "Validate context before any run starts.",
        userStories: [],
        conversationSessionId: "session.context-cli",
        goalEnvelope: {
            objective: "Validate the context file.",
            constraints: [],
            acceptanceCriteria: ["Malformed context is rejected."],
            nonGoals: [],
            assumptions: [],
        },
    }))
    writeFileSync(join(dir, "invalid-context.json"), JSON.stringify({
        schemaVersion: 1,
        sessionId: "session.context-cli",
    }))
    return dir
}
