// Stand-in `opencode` binaries in the suite record or act on every argv,
// including a `--version` probe; pin the 1.x flags they were written for.
process.env.BARO_OPENCODE_MAJOR ??= "1"

// Stand-in agent CLIs across the suite write fixtures outside their worktree
// on purpose. Lane tests exercise lane logic; the OS sandbox has its own tests
// (test/harness/os-sandbox.test.ts), which pass their environment explicitly.
process.env.BARO_UNSAFE_NO_SANDBOX ??= "1"
