/**
 * CriticCodex — one-shot acceptance evaluator via `codex exec --json`.
 *
 * Codex is an agentic harness rather than a tool-less inference API, so the
 * evaluator turn runs in a fresh directory with a deny-workspace permission
 * profile, no inherited tool environment, no web, and no ambient
 * configuration. The bounded evidence is piped over stdin and never exposed
 * as repository state or command-line arguments.
 */

import { runCodexOneShot } from "../codex-one-shot.js"
import { VERDICT_SYSTEM_PROMPT, extractVerdictJson } from "./critic.js"
import {
    OneShotCritic,
    type OneShotCriticCoreOptions,
    type OneShotCriticEvaluation,
    type OneShotCriticInvocationContext,
} from "./critic-one-shot.js"

export interface CriticCodexOptions extends OneShotCriticCoreOptions {
    /** Codex model used for verdict calls. Default: undefined (Codex picks). */
    model?: string
    /** Path to the `codex` binary. Default: "codex". */
    codexBin?: string
}

export class CriticCodex extends OneShotCritic {
    private readonly model: string | undefined
    private readonly codexBin: string

    constructor(opts: CriticCodexOptions) {
        super(opts, {
            backend: "codex",
            defaultModelLabel: "codex-default",
            errorLabel: "CriticCodex",
        }, opts.model)
        this.model = opts.model
        this.codexBin = opts.codexBin ?? "codex"
    }

    protected override invoke(
        prompt: string,
        context: OneShotCriticInvocationContext,
    ): Promise<string> {
        return runCodexOneShot({
            prompt: `${VERDICT_SYSTEM_PROMPT}\n\n${prompt}`,
            promptViaStdin: true,
            cwd: context.cwd,
            model: this.model,
            codexBin: this.codexBin,
            timeoutMs: context.timeoutMs,
            label: "codex-critic",
            // Critic receives every fact through the bounded prompt. Its
            // Codex harness may authenticate, but spawned tools cannot see
            // a checkout, inherited secrets, or the web.
            bypassSandbox: false,
            isolateToolFilesystem: true,
            ephemeral: true,
            ignoreUserConfig: true,
            ignoreRules: true,
            disableHooks: true,
            neverApprove: true,
            disableWebSearch: true,
            disableProjectDocs: true,
            skipGitRepoCheck: true,
            onInvocation: context.onInvocation,
        })
    }

    protected override parseVerdict(text: string): OneShotCriticEvaluation {
        const parsed: unknown = JSON.parse(extractVerdictJson(text.trim()))
        if (!isCodexVerdict(parsed)) {
            throw new Error("Codex critic returned an invalid verdict object")
        }
        return {
            status: "evaluated",
            verdict: parsed.verdict,
            reasoning: parsed.reasoning,
            violatedCriteria: [...parsed.violated_criteria],
        }
    }
}

interface CodexVerdict {
    verdict: "pass" | "fail"
    reasoning: string
    violated_criteria: string[]
}

function isCodexVerdict(value: unknown): value is CodexVerdict {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false
    }
    const candidate = value as Record<string, unknown>
    const keys = Object.keys(candidate).sort()
    const exactKeys = ["reasoning", "verdict", "violated_criteria"]
    if (
        keys.length !== exactKeys.length ||
        keys.some((key, index) => key !== exactKeys[index])
    ) {
        return false
    }
    const violatedCriteria = candidate.violated_criteria
    if (
        !Array.isArray(violatedCriteria) ||
        violatedCriteria.some(
            (criterion) =>
                typeof criterion !== "string" || !criterion.trim(),
        )
    ) {
        return false
    }
    return (
        (candidate.verdict === "pass" || candidate.verdict === "fail") &&
        typeof candidate.reasoning === "string" &&
        Boolean(candidate.reasoning.trim()) &&
        (candidate.verdict === "pass"
            ? violatedCriteria.length === 0
            : violatedCriteria.length > 0)
    )
}
