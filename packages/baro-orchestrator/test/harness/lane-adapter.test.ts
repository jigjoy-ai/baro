import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    LaneCapabilityUnsupported,
    mergeGrants,
    type HostFunction,
    type InteractiveLaneAdapter,
    type LaneCapability,
    type LaneGrant,
} from "../../src/harness/lane-adapter.js"
import { ClaudeLaneAdapter } from "../../src/harness/claude/lane-adapter.js"
import { MozaikLaneAdapter } from "../../src/harness/mozaik/lane-adapter.js"
import {
    isNativeLane,
    laneAdapterFor,
    registerLane,
} from "../../src/harness/lane-registry.js"

const publishFragment: HostFunction = {
    name: "publish_plan_fragment",
    description: "admit a plan fragment",
    parameters: { type: "object", properties: {} },
    invoke: async () => JSON.stringify({ admitted: ["S1"] }),
}

const readRepo: LaneCapability = { kind: "read-repo", cwd: "/repo" }
const callHost: LaneCapability = { kind: "host-function", fn: publishFragment }

describe("a capability costs what the lane charges for it", () => {
    it("is a function on the lane that can be handed one", async () => {
        const grant = await new MozaikLaneAdapter({ backend: "openai" }).grant([
            callHost,
        ])
        const names = (grant.tools ?? []).map((tool) => tool.name)
        assert.deepEqual(names, ["publish_plan_fragment"])
        assert.equal(
            grant.cliExtraArgs,
            undefined,
            "a lane in this process has no command line",
        )
        assert.equal(
            await (grant.tools![0] as unknown as HostFunction).invoke({}),
            JSON.stringify({ admitted: ["S1"] }),
            "calling the tool calls the host function, with nothing in between",
        )
    })

    it("is a spawned server on the lane that lives in another process", async () => {
        let exposed: readonly HostFunction[] = []
        let closed = 0
        const adapter = new ClaudeLaneAdapter({
            hostFunctionBridge: {
                expose: async (functions) => {
                    exposed = functions
                    return {
                        cliExtraArgs: ["--mcp-config", '{"mcpServers":{"relay":{}}}'],
                        close: async () => {
                            closed += 1
                        },
                    }
                },
            },
        })

        const grant = await adapter.grant([callHost])
        assert.deepEqual(
            exposed.map((fn) => fn.name),
            ["publish_plan_fragment"],
        )
        assert.match(grant.cliExtraArgs!.join(" "), /--mcp-config/u)
        assert.equal(grant.tools, undefined, "a CLI is told names, not functions")
        await grant.close()
        assert.equal(closed, 1, "the grant owns the relay it opened")
    })

    it("refuses by name rather than pretending, when it has no way to expose one", async () => {
        const adapter = new ClaudeLaneAdapter()
        await assert.rejects(
            adapter.grant([callHost]),
            (error: Error) =>
                error instanceof LaneCapabilityUnsupported &&
                /claude lane cannot grant "host-function \(publish_plan_fragment\)"/u.test(
                    error.message,
                ),
        )
    })

    it("still grants repository reading without any relay at all", async () => {
        const grant = await new ClaudeLaneAdapter().grant([readRepo])
        const args = grant.cliExtraArgs!.join(" ")
        assert.match(args, /--tools Read,Glob,Grep/u)
        assert.match(args, /--strict-mcp-config/u)
        assert.match(
            args,
            /--mcp-config \{"mcpServers":\{\}\}/u,
            "an empty server list is stated, never inherited from the user",
        )
    })

    it("gives the native lane the same reading as read-only functions", async () => {
        const grant = await new MozaikLaneAdapter({ backend: "openai" }).grant([
            readRepo,
        ])
        const names = (grant.tools ?? []).map((tool) => tool.name).sort()
        assert.deepEqual(names, [
            "file_tree",
            "glob",
            "grep",
            "list_files",
            "read_file",
        ])
        assert.ok(
            !names.includes("bash") && !names.includes("write_file"),
            "a session that reads a repository never gains a way to change it",
        )
    })
})

describe("which lane answers for a backend", () => {
    it("sends a model we call directly to the lane with no process", () => {
        for (const backend of ["openai", "jigjoy", "deepseek-compatible"]) {
            assert.equal(isNativeLane(backend), true)
            assert.equal(
                laneAdapterFor({ backend }) instanceof MozaikLaneAdapter,
                true,
            )
        }
    })

    it("sends claude to its own adapter, not to the native one", () => {
        const adapter = laneAdapterFor({ backend: "claude" })
        assert.equal(adapter instanceof ClaudeLaneAdapter, true)
        assert.equal(adapter.backend, "claude")
    })

    // The point of the registry: a third lane is an entry, not an edit.
    it("takes a new lane without any existing lane changing", () => {
        class OpenCodeLane implements InteractiveLaneAdapter {
            readonly backend = "opencode"
            async grant(): Promise<LaneGrant> {
                return { cliExtraArgs: ["--opencode-tools"], close: async () => {} }
            }
            create(): never {
                throw new Error("not needed for this test")
            }
        }
        registerLane("opencode", () => new OpenCodeLane())

        const adapter = laneAdapterFor({ backend: "opencode" })
        assert.equal(adapter.backend, "opencode")
        assert.equal(isNativeLane("opencode"), false)
        // Everything else answers exactly as before.
        assert.equal(
            laneAdapterFor({ backend: "claude" }) instanceof ClaudeLaneAdapter,
            true,
        )
        assert.equal(
            laneAdapterFor({ backend: "openai" }) instanceof MozaikLaneAdapter,
            true,
        )
    })
})

describe("grants compose without leaking what they opened", () => {
    it("closes every grant even when one refuses to close", async () => {
        const closed: string[] = []
        const ok = (name: string): LaneGrant => ({
            close: async () => {
                closed.push(name)
            },
        })
        const bad: LaneGrant = {
            close: async () => {
                closed.push("bad")
                throw new Error("relay would not stop")
            },
        }

        const merged = mergeGrants([ok("first"), bad, ok("third")])
        await assert.rejects(merged.close(), /relay would not stop/u)
        assert.deepEqual(closed, ["first", "bad", "third"])
    })

    it("merges what each lane produced", () => {
        const merged = mergeGrants([
            { cliExtraArgs: ["--a"], close: async () => {} },
            { cliExtraArgs: ["--b"], close: async () => {} },
        ])
        assert.deepEqual(merged.cliExtraArgs, ["--a", "--b"])
    })
})
