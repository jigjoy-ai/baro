import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { describe, it } from "node:test"

import { globSync } from "node:fs"

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..")
const PORT = join("src", "runtime", "mozaik.ts")
// This guard names the package as data; it is not an import of it.
const SELF = join("test", "runtime", "mozaik-port.test.ts")

describe("mozaik anti-corruption port", () => {
    it("is the only module importing @mozaik-ai/core directly", () => {
        const offenders: string[] = []
        for (const dir of ["src", "test", "scripts"]) {
            for (const file of globSync(join(PACKAGE_ROOT, dir, "**", "*.ts"))) {
                const rel = relative(PACKAGE_ROOT, file)
                if (rel.split(sep).includes("node_modules")) continue
                if (rel === PORT || rel === SELF) continue
                if (readFileSync(file, "utf8").includes('"@mozaik-ai/core"')) {
                    offenders.push(rel)
                }
            }
        }
        assert.deepEqual(
            offenders,
            [],
            "import Mozaik symbols from src/runtime/mozaik.js, never from " +
                "@mozaik-ai/core directly — the v4 migration must stay one seam",
        )
    })
})
