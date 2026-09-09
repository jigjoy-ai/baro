import { resolve } from "node:path"

import {
    parseOperatorMcpInvocation,
    runOperatorMcpServer,
} from "../src/operator/host-tools-relay.js"
import { runOperator } from "../src/operator/operator-session.js"

/* `baro operator`: a conversation with Claude Code in front and baro behind.
   The same bundle also serves as the MCP stdio child Claude spawns to reach
   the operator's tools (`__operator-mcp`). */

async function main(): Promise<void> {
    const argv = process.argv.slice(2)
    const mcp = parseOperatorMcpInvocation(argv)
    if (mcp) {
        await runOperatorMcpServer(mcp)
        return
    }

    let cwd = process.cwd()
    let model: string | undefined = "opus"
    let effort: string | undefined
    let claudeBin: string | undefined
    let permission: "ask" | "auto" = "ask"
    const baroArgs: string[] = []
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index]
        const value = argv[index + 1]
        switch (flag) {
            case "--cwd":
                cwd = resolve(value ?? cwd)
                index += 1
                break
            case "--model":
                model = value
                index += 1
                break
            case "--effort":
                effort = value
                index += 1
                break
            case "--claude-bin":
                claudeBin = value
                index += 1
                break
            case "--permission":
                if (value !== "ask" && value !== "auto") {
                    throw new Error("--permission must be ask or auto")
                }
                permission = value
                index += 1
                break
            case "--local-only":
                baroArgs.push("--local-only")
                break
            case "--llm":
                baroArgs.push("--llm", value ?? "")
                index += 1
                break
            case "--help":
            case "-h":
                process.stdout.write(
                    "usage: operator [--cwd <repo>] [--model opus] [--effort high] [--permission ask|auto] [--local-only] [--llm <backend>]\n",
                )
                return
            default:
                throw new Error(`unknown flag: ${flag}`)
        }
    }
    await runOperator({
        cwd,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(claudeBin ? { claudeBin } : {}),
        permission,
        baroArgs,
    })
}

main().catch((error) => {
    process.stderr.write(`operator: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
})
