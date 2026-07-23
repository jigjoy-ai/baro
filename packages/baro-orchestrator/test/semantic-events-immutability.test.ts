import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    BaseObserver,
    type Participant,
    type SemanticEvent,
} from "../src/runtime/mozaik.js"

import {
    ConversationDelegationProposed,
    type ConversationDelegationProposedData,
} from "../src/semantic-events.js"
import { conversationDelegationProposalId } from "../src/participants/conversation-delegation.js"
import { captureEnv, source } from "./participants/helpers.js"

class SynchronousMutator extends BaseObserver {
    readonly errors: unknown[] = []

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (!ConversationDelegationProposed.is(event)) return
        const data = event.data as unknown as {
            baseGraphVersion: number
            addedStories: Array<{ id: string }>
        }
        for (const mutation of [
            () => { data.baseGraphVersion = 99 },
            () => { data.addedStories[0]!.id = "attacker-story" },
            () => { data.addedStories.push({ id: "extra-story" }) },
        ]) {
            try {
                mutation()
            } catch (error) {
                this.errors.push(error)
            }
        }
    }
}

class SynchronousReceiver extends BaseObserver {
    received: ConversationDelegationProposedData | null = null

    override onExternalEvent(
        _source: Participant,
        event: SemanticEvent<unknown>,
    ): void {
        if (ConversationDelegationProposed.is(event)) this.received = event.data
    }
}

describe("Baro semantic event immutability", () => {
    it("snapshots and deeply freezes authority payloads before Mozaik fan-out", () => {
        const messageId = "message-immutable"
        const callerData = {
            runId: "run-immutable",
            messageId,
            proposalId: conversationDelegationProposalId(
                "run-immutable",
                messageId,
            ),
            agentId: "dialogue",
            baseGraphVersion: 1,
            reason: "Add bounded work.",
            addedStories: [{
                id: "S2",
                title: "Implement S2",
                description: "Implement the bounded S2 scope.",
                dependsOn: ["S1"],
                acceptance: ["S2 works"],
                tests: ["npm test"],
            }],
        }
        const event = ConversationDelegationProposed.create(callerData)

        // Holding the producer's original input must not retain a write handle
        // into the event that will cross an authority boundary.
        callerData.baseGraphVersion = 7
        callerData.addedStories[0]!.id = "caller-rewrite"

        const mutator = new SynchronousMutator()
        const receiver = new SynchronousReceiver()
        const env = captureEnv()
        // Mozaik delivers in subscription order; this is the hostile ordering
        // that previously let an earlier subscriber rewrite a later mailbox.
        mutator.join(env)
        receiver.join(env)
        env.deliverSemanticEvent(source("dialogue"), event)

        assert.equal(Object.isFrozen(event), true)
        assert.equal(Object.isFrozen(event.data), true)
        assert.equal(Object.isFrozen(event.data.addedStories), true)
        assert.equal(Object.isFrozen(event.data.addedStories[0]), true)
        assert.equal(mutator.errors.length, 3)
        assert.equal(receiver.received?.baseGraphVersion, 1)
        assert.equal(receiver.received?.addedStories[0]?.id, "S2")
        assert.equal(receiver.received?.addedStories.length, 1)
    })
})
