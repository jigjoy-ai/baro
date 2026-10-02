import { randomUUID } from "node:crypto"
import { renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * Write-then-rename, so a reader never sees half a file. When the destination
 * cannot be replaced the contents are written in place instead: the Rust host
 * keeps its result file open while the child runs, and Windows refuses to
 * replace an open file. Every Architect there finished its work and then
 * crashed on the rename (#192).
 */
export function writeFileAtomic(
    path: string,
    contents: string,
    rename: (from: string, to: string) => void = renameSync,
): void {
    const temporary = join(
        dirname(path),
        `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    )
    try {
        writeFileSync(temporary, contents, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        })
        try {
            rename(temporary, path)
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code
            if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error
            writeFileSync(path, contents, { encoding: "utf8" })
        }
    } finally {
        rmSync(temporary, { force: true })
    }
}
