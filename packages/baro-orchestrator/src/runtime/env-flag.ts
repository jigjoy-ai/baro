/** Opt-out env flag: unset/missing or any non-"0" value → enabled (true); only the literal "0" → disabled (false). */
export function envFlag(name: string): boolean {
    return process.env[name] !== "0";
}
