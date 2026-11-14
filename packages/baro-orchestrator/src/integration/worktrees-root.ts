import { tmpdir } from "node:os"
import { join } from "node:path"

/** Spotlight skips a directory named `*.noindex`; a run writes tens of thousands of files here. */
export const WORKTREES_DIR_NAME = "baro-worktrees.noindex"
/** Runs of older versions, still swept and still recognised in paths. */
export const LEGACY_WORKTREES_DIR_NAME = "baro-worktrees"

export function worktreesRoot(): string {
    return join(tmpdir(), WORKTREES_DIR_NAME)
}

export function legacyWorktreesRoot(): string {
    return join(tmpdir(), LEGACY_WORKTREES_DIR_NAME)
}
