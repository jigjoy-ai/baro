import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildInstallServiceArgs, buildReexec, parseDoneSuccess, semverLt } from "../scripts/runner-helpers.js"

describe("semverLt", () => {
    it("orders plain semvers", () => {
        assert.equal(semverLt("0.58.0", "0.72.1"), true)
        assert.equal(semverLt("0.72.1", "0.72.1"), false)
        assert.equal(semverLt("0.72.2", "0.72.1"), false)
        assert.equal(semverLt("0.9.9", "0.10.0"), true)
    })
})

describe("buildReexec", () => {
    it("re-runs the same script + args under the same node, with the loop guard set", () => {
        const r = buildReexec("/usr/bin/node", ["/usr/bin/node", "/g/runner.mjs", "--flag"], { RUNNER_TOKEN: "rt_x", PATH: "/bin" })
        assert.equal(r.cmd, "/usr/bin/node")
        assert.deepEqual(r.args, ["/g/runner.mjs", "--flag"])
        assert.equal(r.env.BARO_UPDATED, "1")
        assert.equal(r.env.RUNNER_TOKEN, "rt_x") // same credentials → same runnerId pairing
    })

    it("does not mutate the caller's env", () => {
        const env = { PATH: "/bin" }
        buildReexec("/usr/bin/node", ["/usr/bin/node", "s.mjs"], env)
        assert.equal("BARO_UPDATED" in env, false)
    })
})

describe("buildInstallServiceArgs", () => {
    it("builds the install-service invocation with the paired token + workspace", () => {
        assert.deepEqual(buildInstallServiceArgs({ token: "rt_abc", workspace: "/w" }), ["connect", "--install-service", "--token", "rt_abc", "--workspace", "/w"])
    })

    it("passes the control-plane override through when set", () => {
        const args = buildInstallServiceArgs({ token: "rt_abc", workspace: "/w", controlUrl: "wss://staging" })
        assert.deepEqual(args.slice(-2), ["--control-url", "wss://staging"])
    })
})

describe("parseDoneSuccess", () => {
    it("preserves explicit outcomes and treats a legacy missing field as success", () => {
        assert.equal(parseDoneSuccess(true), true)
        assert.equal(parseDoneSuccess(false), false)
        assert.equal(parseDoneSuccess(undefined), true)
        assert.equal(parseDoneSuccess("false"), null)
        assert.equal(parseDoneSuccess(null), null)
    })
})
