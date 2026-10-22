import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { basename, dirname, join, relative, sep } from "node:path"
import { describe, it } from "node:test"

import { globSync } from "node:fs"

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..")
const SEAM_DIR = join("src", "runtime")
// This guard names the packages as data; it is not an import of them.
const SELF = join("test", "runtime", "mozaik-port.test.ts")
const MOZAIK_IMPORT = /["'](@mozaik-ai\/[^"']+|mozaik-core-v3)["']/

function isSeam(rel: string): boolean {
    return dirname(rel) === SEAM_DIR && /^mozaik[\w-]*\.ts$/.test(basename(rel))
}

describe("mozaik anti-corruption port", () => {
    it("keeps every Mozaik package import inside src/runtime/mozaik*.ts", () => {
        const offenders: string[] = []
        for (const dir of ["src", "test", "scripts"]) {
            for (const file of globSync(join(PACKAGE_ROOT, dir, "**", "*.ts"))) {
                const rel = relative(PACKAGE_ROOT, file)
                if (rel.split(sep).includes("node_modules")) continue
                if (isSeam(rel) || rel === SELF) continue
                if (MOZAIK_IMPORT.test(readFileSync(file, "utf8"))) {
                    offenders.push(rel)
                }
            }
        }
        assert.deepEqual(
            offenders,
            [],
            "import Mozaik symbols from src/runtime/mozaik.js, never from " +
                "the packages directly — the v4 migration must stay one seam",
        )
    })
})
