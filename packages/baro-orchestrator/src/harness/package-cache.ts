import { mkdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

export function storyPackageCache(env: NodeJS.ProcessEnv = process.env): StoryPackageCache {
    const configured = env.BARO_PACKAGE_CACHE?.trim()
    const requested = configured ? configured : join(homedir(), ".baro", "cache", "packages")
    mkdirSync(requested, { recursive: true })
    const root = realpathSync(requested)
    const at = (name: string) => join(root, name)
    return {
        root,
        env: {
            npm_config_cache: at("npm"),
            npm_config_store_dir: at("pnpm-store"),
            YARN_CACHE_FOLDER: at("yarn"),
            PIP_CACHE_DIR: at("pip"),
            UV_CACHE_DIR: at("uv"),
            XDG_CACHE_HOME: at("xdg"),
            GOCACHE: at("go-build"),
            GOMODCACHE: at("go-mod"),
            CARGO_HOME: at("cargo"),
        },
    }
}
