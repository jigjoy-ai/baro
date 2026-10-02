// Shared by both stand-ins: the smallest valid reply for each phase, so a run
// travels the whole pipeline without a model.
const DECISION_DOCUMENT = `## Existing context
The repository is a tiny Node sample.

## ADR-001: Add one script
**Status:** Accepted
**Context:** The goal asks for a single new file.
**Decision:** Add goodbye.js at the repository root.
**Consequences:** No other file changes.`

export function phaseOf(prompt) {
    const head = prompt.trimStart().slice(0, 200)
    if (head.startsWith("You are Baro Conversation")) return "conversation"
    if (head.startsWith("You are Baro RepoScout")) return "scout"
    if (head.startsWith("You are the architect")) return "architect"
    if (head.startsWith("You classify software tasks")) return "intake"
    if (head.startsWith("You are an expert software architect. Break down")) return "planner"
    if (head.startsWith("## Shared Memory System") || /\bYou are .*story agent\b/i.test(head)) return "story"
    if (head.startsWith("You compile a bounded part of a machine-checkable architecture obligation")) return "obligations"
    return "other"
}

export function replyFor(prompt) {
    const phase = phaseOf(prompt)
    if (phase === "conversation") {
        const sessionId = prompt.match(/SESSION ID: ([\w-]+)/)?.[1]
        const requestId = prompt.match(/REQUEST ID: ([\w-]+)/)?.[1]
        return JSON.stringify({
            schemaVersion: 1,
            sessionId,
            requestId,
            kind: "ready",
            message: "Clear; handing this to planning.",
            questions: [],
            goalEnvelope: {
                objective: "Add a goodbye.js file that prints goodbye.",
                constraints: [],
                acceptanceCriteria: ["Running node goodbye.js prints goodbye."],
                nonGoals: [],
                assumptions: [],
            },
        })
    }
    if (phase === "architect") {
        return JSON.stringify({
            schemaVersion: 1,
            kind: "ready",
            message: "Repository validation is complete.",
            questions: [],
            evidence: [],
            constraintPredicates: [],
            decisionDocument: DECISION_DOCUMENT,
        })
    }
    if (phase === "obligations") {
        return JSON.stringify({
            schemaVersion: 1,
            obligations: [{
                adrIds: ["ADR-001"],
                invariantIds: ["G-A1"],
                subject: "goodbye.js",
                scenario: "node goodbye.js is run from the repository root",
                expectedOutcome: "it prints goodbye and exits 0",
                evidence: ["the captured output of node goodbye.js"],
            }],
        })
    }
    if (phase === "intake") {
        return JSON.stringify({ mode: "focused", confidence: 0.9, reason: "one file", maxStories: 1, parallelism: 1 })
    }
    if (phase === "planner") {
        const canonical = [...prompt.matchAll(/^\[O-\d+\]; Subject: .*$/gm)].map((m) => m[0].trim())
        return JSON.stringify({
            project: "sample",
            branchName: "add-goodbye",
            description: "Add goodbye.js",
            userStories: [{
                id: "S1",
                priority: 1,
                title: "Add goodbye.js",
                description: "Create goodbye.js at the repository root that prints goodbye.",
                dependsOn: [],
                writes: ["goodbye.js"],
                retries: 1,
                acceptance: canonical.length > 0 ? canonical : ["node goodbye.js prints goodbye"],
                tests: ["node --check goodbye.js"],
                goalInvariantIds: ["G-A1"],
                model: "standard",
            }],
        })
    }
    if (phase === "story") return "Created goodbye.js; node goodbye.js prints goodbye."
    return "I cannot complete this request."
}
