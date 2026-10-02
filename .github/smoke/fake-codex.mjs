// Stand-in Codex CLI for the Windows smoke run: reads the prompt from stdin
// and answers with the minimal valid reply for that phase.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { phaseOf, replyFor } from "./reply.mjs"

const log = process.env.FAKE_CODEX_LOG
const argv = process.argv.slice(2)
appendFileSync(log, `${new Date().toISOString()} start argv=${JSON.stringify(argv).slice(0, 600)}\n`)
let stdin = ""
try { stdin = readFileSync(0, "utf8") } catch (e) { stdin = `<stdin error ${e.code}>` }
appendFileSync(log, `${new Date().toISOString()} stdin bytes=${stdin.length}\n`)
const text = replyFor(stdin)
if (phaseOf(stdin) === "story") {
    writeFileSync("goodbye.js", "console.log('goodbye')\n")
    appendFileSync(log, `  story wrote goodbye.js in ${process.cwd()}\n`)
}
appendFileSync(log, `  phase=${phaseOf(stdin)} head=${JSON.stringify(stdin.trimStart().slice(0, 90))} -> ${text.slice(0, 60)}\n`)
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }))
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }))
appendFileSync(log, `${new Date().toISOString()} exit\n`)
