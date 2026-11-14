import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"

// True when the suite itself runs under Seatbelt (e.g. a Baro story working on
// this repo): Seatbelt cannot nest and denies setuid binaries such as /bin/ps,
// so tests that need either can only pass on the host.
export const INSIDE_MACOS_SANDBOX =
    process.platform === "darwin" &&
    existsSync("/usr/bin/sandbox-exec") &&
    spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
        stdio: "ignore",
    }).status !== 0
