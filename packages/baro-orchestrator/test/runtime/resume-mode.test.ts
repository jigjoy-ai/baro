import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { resumeRunRequested } from "../../src/runtime/resume-mode.js"

describe("resumeRunRequested", () => {
    it("argv --resume alone (no BARO_RESUME) enters resume mode", () => {
        assert.equal(resumeRunRequested(["--resume"], {}), true)
    })

    it("BARO_RESUME=1 alone (no argv flag) enters resume mode", () => {
        assert.equal(
            resumeRunRequested(["--prd", "prd.json"], { BARO_RESUME: "1" }),
            true,
        )
    })

    it("no argv flag and no env var does not enter resume mode", () => {
        assert.equal(resumeRunRequested([], {}), false)
    })

    it("BARO_RESUME=0 does not enter resume mode", () => {
        assert.equal(resumeRunRequested([], { BARO_RESUME: "0" }), false)
    })

    it("argv --resume and BARO_RESUME=1 together still enter resume mode", () => {
        assert.equal(resumeRunRequested(["--resume"], { BARO_RESUME: "1" }), true)
    })
})
