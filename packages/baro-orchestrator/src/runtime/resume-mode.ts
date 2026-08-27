export function resumeRunRequested(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
    return argv.includes("--resume") || env.BARO_RESUME === "1"
}
