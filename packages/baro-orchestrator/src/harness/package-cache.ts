import { mkdirSync, readdirSync, realpathSync, type Dirent } from "node:fs"
import { join } from "node:path"
import { gitSandboxPaths } from "../execution/shell-containment.js"
import { baroHome } from "../runtime/baro-home.js"
import { repositoryCacheKey } from "../verification/cargo-env.js"

/**
 * Where a sandboxed story's package managers keep their caches. Story
 * sandboxes cannot write the user's own caches (~/.npm, ~/Library/Caches,
 * ~/.cargo): a cache a story could write is one it could poison for the
 * user's next install outside Baro. Without a writable cache npm refuses to
 * install at all, so each tool is pointed at a Baro-owned cache instead,
 * shared by Baro's stories and nothing else. BARO_PACKAGE_CACHE overrides it.
 */
export interface StoryPackageCache {
    root: string
    env: Record<string, string>
}

export function packageCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.BARO_PACKAGE_CACHE?.trim()
    return configured ? configured : join(baroHome(), "cache", "packages")
}

export function storyPackageCache(
    env: NodeJS.ProcessEnv = process.env,
    worktreeRoot: string | null = null,
): StoryPackageCache {
    const requested = packageCacheRoot(env)
    mkdirSync(requested, { recursive: true })
    const root = realpathSync(requested)
    const at = (name: string) => join(root, name)
    return {
        root,
        env: {
            npm_config_cache: at("npm"),
            pnpm_config_store_dir: at("pnpm-store"),
            YARN_CACHE_FOLDER: at("yarn"),
            PIP_CACHE_DIR: at("pip"),
            UV_CACHE_DIR: at("uv"),
            XDG_CACHE_HOME: at("xdg"),
            GOCACHE: at("go-build"),
            GOMODCACHE: at("go-mod"),
            CARGO_HOME: at("cargo"),
            ...(worktreeRoot === null ? {} : { CARGO_TARGET_DIR: storyCargoTargetDir(root, worktreeRoot) }),
        },
    }
}

/**
 * One cargo target dir per repository for all stories: a fresh worktree's own
 * target/ made every story rebuild all dependencies. Cargo keys artifacts by
 * source path and locks the dir, so sharing is safe across worktrees.
 */
export function storyCargoTargetDir(cacheRoot: string, worktreeRoot: string): string {
    const repository = gitSandboxPaths(worktreeRoot).commonWorktreeRoot ?? worktreeRoot
    const dir = join(cacheRoot, "cargo-target", repositoryCacheKey(repository))
    mkdirSync(dir, { recursive: true })
    return dir
}

const SHARED_DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "vendor"])
const SCAN_SKIP = new Set([".git", "dist", "build", "target", ".next", "out", "coverage"])

/**
 * The real targets of the dependency dirs a worktree links to its run's
 * shared copy (integration/worktree.ts): one story's install must be visible
 * to the others, so a sandbox has to let a story write through those links.
 * Only symlinked dependency dirs count; a real one is inside the worktree.
 */
export function sharedDependencyTargets(worktreeRoot: string, depth = 4): string[] {
    const targets = new Set<string>()
    const scan = (dir: string, left: number): void => {
        let entries: Dirent[]
        try {
            entries = readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const full = join(dir, entry.name)
            if (SHARED_DEPENDENCY_DIRS.has(entry.name)) {
                if (entry.isSymbolicLink()) {
                    try {
                        targets.add(realpathSync(full))
                    } catch {}
                }
                continue
            }
            if (left > 0 && entry.isDirectory() && !SCAN_SKIP.has(entry.name)) scan(full, left - 1)
        }
    }
    scan(worktreeRoot, depth)
    return [...targets]
}
