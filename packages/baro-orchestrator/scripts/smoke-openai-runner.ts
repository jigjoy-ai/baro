#!/usr/bin/env tsx
/**
 * Smoke test for Mozaik 3.9's native OpenAI inference runner.
 *
 * Run this BEFORE Phase 3 wires the first OpenAI sibling participant.
 * Goal: confirm that OPENAI_API_KEY + the model name baked into
 * @mozaik-ai/core actually return a response in your account.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx packages/baro-orchestrator/scripts/smoke-openai-runner.ts
 *
 * Optional:
 *   --model gpt-5.4 | gpt-5.4-mini | gpt-5.4-nano | gpt-5.5
 *     (default: gpt-5.4-mini — cheapest of the four)
 *
 * Exit 0 = the runner returned a non-empty model message.
 * Exit 1 = HTTP/auth/model-not-found error (the message tells which).
 *
 * No bus, no participants, no tools — pure connectivity check.
 */

import {
    Gpt54,
    Gpt54Mini,
    Gpt54Nano,
    Gpt55,
    ModelContext,
    OpenAIInferenceRunner,
    SystemMessageItem,
    UserMessageItem,
    type GenerativeModel,
} from "@mozaik-ai/core"

function pickModel(name: string): GenerativeModel {
    switch (name) {
        case "gpt-5.4":
            return new Gpt54()
        case "gpt-5.4-mini":
            return new Gpt54Mini()
        case "gpt-5.4-nano":
            return new Gpt54Nano()
        case "gpt-5.5":
            return new Gpt55()
        default:
            throw new Error(
                `Unknown model '${name}'. Use one of: gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.5`,
            )
    }
}

async function main(): Promise<void> {
    if (!process.env.OPENAI_API_KEY) {
        console.error("OPENAI_API_KEY is not set. Export it and re-run.")
        process.exit(1)
    }

    const args = process.argv.slice(2)
    let modelName = "gpt-5.4-mini"
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--model" && args[i + 1]) modelName = args[++i]
    }

    console.log(`Testing Mozaik OpenAI runner with model=${modelName}`)

    const model = pickModel(modelName)

    // ModelContext is immutable — every addContextItem returns a new
    // instance, so chain them rather than expecting mutation.
    const context = ModelContext.create("smoke-test")
        .addContextItem(
            SystemMessageItem.create("You are a smoke-test responder. Reply with exactly: PONG"),
        )
        .addContextItem(UserMessageItem.create("ping"))

    const runner = new OpenAIInferenceRunner()
    const start = Date.now()
    let text = ""
    let messageCount = 0
    let functionCallCount = 0
    let reasoningCount = 0

    try {
        for await (const item of runner.run(context, model)) {
            if (item.type === "message" && item.role === "assistant") {
                messageCount++
                const json = item.toJSON() as { content: Array<{ text: string }> }
                text += json.content?.[0]?.text ?? ""
            } else if (item.type === "function_call") {
                functionCallCount++
            } else if (item.type === "reasoning") {
                reasoningCount++
            }
        }
    } catch (e) {
        const msg = (e as Error)?.message ?? String(e)
        console.error(`\n✗ FAILED after ${Date.now() - start}ms`)
        console.error(`  ${msg}`)
        if (msg.includes("model")) {
            console.error(
                "\n  Hint: Mozaik 3.9.3 ships gpt-5.x model names. If OpenAI hasn't released\n" +
                "        that family in your account yet, try the other --model values, or\n" +
                "        the model name + your account need updating before baro 0.30+ ships.\n",
            )
        }
        process.exit(1)
    }

    const elapsed = Date.now() - start
    console.log(`\n✓ Got response in ${elapsed}ms`)
    console.log(`  messages:      ${messageCount}`)
    console.log(`  tool calls:    ${functionCallCount}`)
    console.log(`  reasoning:     ${reasoningCount}`)
    console.log(`  assistant text: ${JSON.stringify(text)}`)

    if (!text.trim()) {
        console.error("\n✗ FAILED: assistant returned empty text — unexpected.")
        process.exit(1)
    }

    console.log("\n✓ Mozaik OpenAI runner is reachable, authenticated, and returning structured output.")
    console.log("  Phase 3 (Critic + Surgeon on OpenAI) is unblocked.")
    process.exit(0)
}

main().catch((e) => {
    console.error("Smoke test crashed:", e)
    process.exit(2)
})
