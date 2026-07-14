// Ambient types for cross-spawn (ships none; we avoid the @types dep). Its
// signature matches child_process.spawn. We route CLI launches through it
// because on Windows the CLIs we spawn (claude/codex/opencode/pi) are .cmd
// shims — Node's spawn() won't resolve PATHEXT without a shell, so spawn("claude")
// throws ENOENT even when claude.cmd is on PATH. cross-spawn resolves the real
// target cross-platform while keeping shell:false (no arg-quoting hazard).
declare module "cross-spawn" {
    import type { ChildProcess, SpawnOptions } from "child_process"
    function spawn(
        command: string,
        args?: readonly string[],
        options?: SpawnOptions,
    ): ChildProcess
    export = spawn
}
