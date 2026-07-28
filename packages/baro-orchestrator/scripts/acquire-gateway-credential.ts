// No shebang: this file is a tsup bundle entry and the build banner adds one.
// A second `#!` line is a hard SyntaxError in an ES module.
import { acquireGatewayCredential } from "../src/gateway-credentials.js"

try {
    const credential = await acquireGatewayCredential()
    process.stdout.write(JSON.stringify(credential))
} catch (error) {
    const message = error instanceof Error ? error.message : "unknown credential exchange failure"
    process.stderr.write(`[baro] ${message}\n`)
    process.exitCode = 1
}
