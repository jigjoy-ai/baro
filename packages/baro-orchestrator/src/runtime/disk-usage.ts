import { lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** Apparent size in bytes; symlinks are counted, never followed. */
export function diskUsage(path: string): number {
    let stat
    try {
        stat = lstatSync(path)
    } catch {
        return 0
    }
    if (!stat.isDirectory()) return stat.size
    let names: string[]
    try {
        names = readdirSync(path)
    } catch {
        return 0
    }
    let total = 0
    for (const name of names) total += diskUsage(join(path, name))
    return total
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
    return `${Math.ceil(bytes / 1024)} KB`
}
