/**
 * A run's own copy of a dependency directory (`node_modules`, `.venv`,
 * `vendor`) that exists in the host checkout.
 *
 * A worktree must never reach the host's copy through a link: `npm ci`
 * deletes the entries of `node_modules` one by one before it installs, and it
 * does that through a symlink, which emptied a checkout a run was started
 * from (#284). A copy-on-write clone costs no disk; where the filesystem has
 * none, hardlinks keep a delete in the copy from touching the host.
 */

import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { copyFile, cp, link, lstat, mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const CLONE_TIMEOUT_MS = 10 * 60_000

export type DependencyCopyMode = "cloned" | "hardlinked" | "copied"

const NO_REFLINK = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL", "ENOTTY", "EPERM"])
const NO_HARDLINK = new Set(["EXDEV", "EPERM", "EMLINK", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])

/**
 * Copies `source` to `dest`, which must not exist. The copy appears under its
 * final name only when complete, so an interrupted copy is never mistaken for
 * installed dependencies.
 */
export async function copyDependencyDir(source: string, dest: string): Promise<DependencyCopyMode> {
    await mkdir(dirname(dest), { recursive: true })
    const staging = `${dest}.baro-copy-${process.pid}-${Date.now().toString(36)}`
    try {
        const mode = await copyTree(source, staging)
        await rename(staging, dest)
        return mode
    } catch (error) {
        await rm(staging, { recursive: true, force: true })
        throw error
    }
}

async function copyTree(source: string, staging: string): Promise<DependencyCopyMode> {
    if (process.platform === "darwin") {
        // libuv has no forced clone on macOS and its plain clone flag copies
        // (measured: 92 s and 675 MB for a tree `cp -c` clones in 7 s).
        try {
            await execFileAsync("/bin/cp", ["-cR", source, staging], { timeout: CLONE_TIMEOUT_MS })
            return "cloned"
        } catch {
            await rm(staging, { recursive: true, force: true })
        }
    } else {
        try {
            await cp(source, staging, {
                recursive: true,
                verbatimSymlinks: true,
                errorOnExist: true,
                force: false,
                mode: constants.COPYFILE_FICLONE_FORCE,
            })
            return "cloned"
        } catch (error) {
            if (!NO_REFLINK.has(errorCode(error))) throw error
            await rm(staging, { recursive: true, force: true })
        }
    }
    const state = { hardlinks: true, copied: false }
    await linkTree(source, staging, state)
    return state.copied ? "copied" : "hardlinked"
}

async function linkTree(
    source: string,
    dest: string,
    state: { hardlinks: boolean; copied: boolean },
): Promise<void> {
    await mkdir(dest, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true })) {
        const from = join(source, entry.name)
        const to = join(dest, entry.name)
        if (entry.isDirectory()) {
            await linkTree(from, to, state)
        } else if (entry.isSymbolicLink()) {
            await symlink(await readlink(from), to)
        } else if (entry.isFile()) {
            if (state.hardlinks) {
                try {
                    await link(from, to)
                    continue
                } catch (error) {
                    if (!NO_HARDLINK.has(errorCode(error))) throw error
                    state.hardlinks = false
                }
            }
            await copyFile(from, to)
            state.copied = true
        }
    }
}

/** True when `path` is a symlink, whatever it points at. */
export async function isSymlink(path: string): Promise<boolean> {
    try {
        return (await lstat(path)).isSymbolicLink()
    } catch {
        return false
    }
}

function errorCode(error: unknown): string {
    return (error as NodeJS.ErrnoException | null)?.code ?? ""
}
