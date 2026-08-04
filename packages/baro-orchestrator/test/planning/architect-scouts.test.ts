import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
    MAX_SCOUT_QUESTIONS,
    buildResearchQuestionsPrompt,
    parseResearchQuestions,
    renderScoutFindings,
    runResearchQuestionRound,
} from "../../src/planning/adapters/architect-scouts.js"

describe("architect scouts", () => {
    it("keeps only usable questions and caps the round", () => {
        const questions = parseResearchQuestions(
            JSON.stringify({
                questions: [
                    { question: "Which module owns menu visibility?", scope: "src/menus" },
                    { question: "short" },
                    { question: "Where is the pagination convention defined?" },
                    ...Array.from({ length: 10 }, (_unused, index) => ({
                        question: `Filler question number ${index} about the repo?`,
                    })),
                ],
            }),
        )
        assert.equal(questions.length, MAX_SCOUT_QUESTIONS)
        assert.equal(questions[0]!.id, "Q1")
        assert.equal(questions[0]!.scope, "src/menus")
        assert.equal(
            questions.some((question) => question.question === "short"),
            false,
            "a question too short to answer is dropped, not asked",
        )
    })

    it("treats unparseable or empty output as no questions", () => {
        assert.deepEqual(parseResearchQuestions("I have no questions."), [])
        assert.deepEqual(parseResearchQuestions('{"questions":"none"}'), [])
        assert.deepEqual(parseResearchQuestions('{"questions":[]}'), [])
    })

    it("reads questions out of a structured-output wrapper", async () => {
        const questions = await runResearchQuestionRound({
            goal: "Migrate validation",
            cwd: "/tmp",
            generate: async () =>
                'Here you go: {"questions":[{"question":"Which DTOs already use zod?"}]}',
        })
        assert.deepEqual(questions.map((q) => q.question), [
            "Which DTOs already use zod?",
        ])
    })

    it("renders findings as the Architect's own questions, answered", () => {
        const rendered = renderScoutFindings([
            { id: "Q1", question: "Who owns X?", answer: "MenuService (src/a.ts:10)", ok: true },
            { id: "Q2", question: "Who owns Y?", answer: "unanswered: timeout", ok: false },
        ])
        assert.match(rendered, /Repository research \(answers to your own questions\)/)
        assert.match(rendered, /### Q1 Who owns X\?/)
        assert.match(rendered, /### Q2 \(unanswered\) Who owns Y\?/)
        assert.equal(renderScoutFindings([]), "")
    })

    it("puts the goal and the confirmed envelope in front of the asker", () => {
        const prompt = buildResearchQuestionsPrompt({
            goal: "Add correlation logging",
            projectContext: "NestJS service",
            goalEnvelope: {
                objective: "Every request carries a correlation id",
                acceptanceCriteria: ["One log line per request"],
                constraints: ["No new dependencies"],
                nonGoals: [],
                assumptions: [],
            },
        })
        assert.match(prompt, /Add correlation logging/)
        assert.match(prompt, /Every request carries a correlation id/)
        assert.match(prompt, /- constraint: No new dependencies/)
        assert.match(prompt, /NestJS service/)
    })
})
