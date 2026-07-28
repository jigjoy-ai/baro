import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tsupConfigPath = join(packageRoot, "..", "baro-app", "tsup.config.ts")

/**
 * The tsup banner prefixes every bundle with a shebang. An entry whose source
 * carries its own produces two `#!` lines, and a shebang past line 1 is a hard
 * SyntaxError — it shipped once and broke `--llm jigjoy` on install, where the
 * bundle only runs on a real user's machine.
 */
describe("bundle entries", () => {
    it("never carry a shebang of their own", () => {
        const config = readFileSync(tsupConfigPath, "utf8")
        assert.match(
            config,
            /banner:[\s\S]{0,200}#!\/usr\/bin\/env node/u,
            "the banner must still be the single source of the shebang",
        )
        const entries = [
            ...config.matchAll(/entry:\s*\{[^}]*?["']?[\w-]+["']?:\s*"([^"]+)"/gu),
        ].map(([, entryPath]) => entryPath!)
        assert.ok(entries.length > 5, "expected the bundle entry list to parse")

        for (const entry of entries) {
            const source = resolve(packageRoot, "..", "baro-app", entry)
            const first = readFileSync(source, "utf8").split("\n", 1)[0] ?? ""
            assert.equal(
                first.startsWith("#!"),
                false,
                `${entry} must not start with a shebang; the tsup banner adds it`,
            )
        }
    })
})
