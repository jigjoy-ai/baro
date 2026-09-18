import { homedir } from "node:os"
import { join } from "node:path"

export function baroHome(): string {
    const override = process.env.BARO_HOME
    return override ? override : join(homedir(), ".baro")
}
