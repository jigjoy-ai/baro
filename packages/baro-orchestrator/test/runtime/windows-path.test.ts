import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { plainWindowsPath } from "../../src/runtime/windows-path.js"

describe("plainWindowsPath (#202)", () => {
    it("drops the verbatim prefix from drive and UNC paths", () => {
        assert.equal(plainWindowsPath("\\\\?\\C:\\Users\\dev\\project"), "C:\\Users\\dev\\project")
        assert.equal(plainWindowsPath("\\\\?\\UNC\\host\\share\\repo"), "\\\\host\\share\\repo")
    })

    it("leaves every other path alone", () => {
        for (const path of [
            "C:\\Users\\dev\\project",
            "/home/dev/project",
            "\\\\?\\Volume{1b3c}\\repo",
            "\\\\?\\C:\\repo\\trailing. \\x",
            `\\\\?\\C:\\${"a".repeat(260)}`,
        ]) assert.equal(plainWindowsPath(path), path)
    })
})
