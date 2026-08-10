import assert from "node:assert/strict"
import { describe, it } from "node:test"

// @ts-expect-error — plain JS install script, deliberately dependency-free
import { shouldClaimLink } from "../../../baro-app/scripts/postinstall.js"

const claim = shouldClaimLink as (
    existing: string | null,
    desired: string,
    exists: (path: string) => boolean,
) => boolean

const alive = () => true
const dead = () => false

describe("who owns the dependency link beside the staged bundles", () => {
    it("takes it when nothing has claimed it", () => {
        assert.equal(claim(null, "/global/node_modules", dead), true)
    })

    it("leaves a live link alone, however temporary this install is", () => {
        // The case that broke a machine: an install running inside a git
        // worktree under /tmp repointed the user's whole installation at a
        // directory that was deleted minutes later.
        assert.equal(
            claim("/global/node_modules", "/tmp/worktree/S1/node_modules", alive),
            false,
        )
    })

    it("repairs a link whose target is gone", () => {
        assert.equal(
            claim("/tmp/worktree/S1/node_modules", "/global/node_modules", dead),
            true,
        )
    })

    it("does nothing when the link already says what it would say", () => {
        assert.equal(claim("/global/node_modules", "/global/node_modules", alive), false)
    })
})
