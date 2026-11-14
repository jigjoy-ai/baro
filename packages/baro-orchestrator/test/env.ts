import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Stand-in `opencode` binaries in the suite record or act on every argv,
// including a `--version` probe; pin the 1.x flags they were written for.
process.env.BARO_OPENCODE_MAJOR ??= "1"

// Stand-in agent CLIs across the suite write fixtures outside their worktree
// on purpose. Lane tests exercise lane logic; the OS sandbox has its own tests
// (test/harness/os-sandbox.test.ts), which pass their environment explicitly.
process.env.BARO_UNSAFE_NO_SANDBOX ??= "1"

// Every orchestrate() run start would otherwise reclaim leftovers of other
// runs in the machine's real TMPDIR and ~/.baro caches. The tests for that
// cleanup turn it back on against a scratch TMPDIR/HOME.
process.env.BARO_RUN_START_CLEANUP ??= "0"

// Keeps the suite off the user's real ~/.baro, which a sandboxed story running
// it cannot write anyway.
if (process.env.BARO_HOME === undefined) {
    const home = mkdtempSync(join(tmpdir(), "baro-test-home-"))
    process.env.BARO_HOME = home
    process.once("exit", () => rmSync(home, { recursive: true, force: true }))
}
