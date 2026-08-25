/**
 * Every boundary that judges a story declares two things from one source:
 * where its enforcement lives, and the rule as the judged party needs to
 * hear it. Prompts are projected from this registry, and a conformance test
 * joins enforcement sites to registered ids — so a new gate cannot judge
 * silently: it is announced here, or the test refuses it.
 *
 * History that made this a rule, not a taste: the merge gate (v0.86), the
 * skipped-check verdict (v0.87), the collective write surface (v0.88) and
 * evidence capture (run 49) each shipped enforcement first and disclosure
 * only after an agent paid for the silence.
 */

export interface GateAnnounceContext {
    /** Declared write surface at spawn; absent for the base prompt stage. */
    surface?: {
        writes: readonly string[]
        ownedElsewhere: Readonly<Record<string, string>>
    }
    /** Collaboration command + capability names for surface remedies. */
    collabCommand?: string
    collabCapability?: string
    /** True when a run-level verifier proves the fully-merged tree once
     * after integration, so stories owe only their own perimeter. */
    hostRunsWholeTreeVerification?: boolean
}

export interface GateDisclosure {
    /** Stable id; enforcement sites name it, the conformance test joins on it. */
    id: string
    /** Module that enforces the rule, for the reader and the test. */
    enforcedBy: string
    /** One line for the run-start announcement events. */
    summary: string
    /** The rule as the judged party needs to hear it; null when inactive. */
    announce(ctx: GateAnnounceContext): string | null
}

const EVIDENCE_CAPTURE: GateDisclosure = {
    id: "evidence-capture",
    enforcedBy: "src/acceptance/critic-evidence.ts",
    summary:
        "Command output is captured automatically and judged against the exact bytes changed.",
    announce: () =>
        [
            "VERIFICATION EVIDENCE (how the reviewer sees your proof) [gate:evidence-capture]:",
            "- The output of every command you run is captured automatically, together with",
            "  the exact bytes changed. That capture IS the evidence the reviewer judges —",
            "  you never need to save, tee, or re-print output yourself.",
            "- Run each verification command ONCE, shaped so its summary lands in the",
            "  visible output (e.g. `npm test 2>&1 | tail -30`, `cargo test 2>&1 | tail -5`).",
            "- Do NOT re-run a passing suite to reformat, slice, or archive its output.",
            "  A re-run costs the suite's full runtime and adds no proof; the first run's",
            "  captured output already counts.",
            "- Make verification the LAST thing before your final summary: any edit after",
            "  it voids the evidence and forces exactly the re-run you are avoiding.",
        ].join("\n"),
}

const BUILD_BEFORE_COMMIT: GateDisclosure = {
    id: "build-before-commit",
    enforcedBy: "src/verification/verify.ts",
    summary: "The project must build before a commit is accepted.",
    announce: () =>
        [
            "IMPORTANT: Before you commit, you MUST verify the project builds successfully [gate:build-before-commit]:",
            "  - If Cargo.toml exists: run `cargo build` and fix all errors and warnings",
            "  - If package.json exists: run `npm run build` (if a build script exists) and fix errors",
            "  - If go.mod exists: run `go build ./...` and fix errors",
            "  - If pyproject.toml or requirements.txt: ensure code is import-clean",
            "  - Otherwise: ensure linting/typecheck passes",
        ].join("\n"),
}

const WRITE_SURFACE: GateDisclosure = {
    id: "write-surface",
    enforcedBy: "src/integration/git-coordinator.ts",
    summary:
        "A diff reaching outside the story's declared writes is refused at integration.",
    announce: (ctx) => {
        const surface = ctx.surface
        if (!surface || surface.writes.length === 0) return null
        const owners = Object.entries(surface.ownedElsewhere)
        const command = ctx.collabCommand ?? "agent-collab"
        const capability = ctx.collabCapability ?? "note"
        return [
            "## Your write surface [gate:write-surface]",
            "",
            "The files this story declared it would write, and the only ones",
            "the merge gate will accept from you:",
            "",
            ...surface.writes.map((path) => `- ${path}`),
            "",
            ...(owners.length > 0
                ? [
                      "Owned by other stories in this run. A diff touching one of",
                      "these is refused at integration, however small and however",
                      "right it is:",
                      "",
                      ...owners
                          .slice(0, 40)
                          .map(([path, owner]) => `- ${path} → ${owner}`),
                      ...(owners.length > 40
                          ? [`- …and ${owners.length - 40} more`]
                          : []),
                      "",
                  ]
                : []),
            ...surfaceRemedyLines(command, capability),
        ].join("\n")
    },
}

/**
 * The remedies for needing a change outside your surface — one source for
 * the prompt disclosure and the write-time hook refusal.
 */
export function surfaceRemedyLines(
    command: string,
    capability: string,
): string[] {
    return [
        "If you need a change in a file you do not own — a bug, a wrong",
        "import, a missing helper — do NOT edit it and do NOT copy it into",
        "your own surface. One of these instead:",
        `- Ask the owner, who can still act: ${command} emit ${capability} --kind help --reason ${JSON.stringify("WHAT NEEDS CHANGING IN <FILE>, PLUS THE COMMAND AND OUTPUT THAT SHOW WHY")}`,
        "- If the architecture contract is what is wrong, withdraw that claim",
        "  with the dispute command above instead of repairing around it.",
        "- If you cannot honestly finish without the change, block on the",
        "  owning story rather than reaching into it.",
        "Working outside your surface loses the whole story at the gate, not",
        "just the stray edit.",
    ]
}

/** Base-prompt gates: active for every story regardless of spawn context. */
export const BASE_GATES: readonly GateDisclosure[] = [
    EVIDENCE_CAPTURE,
    BUILD_BEFORE_COMMIT,
]

const RUN_VERIFICATION: GateDisclosure = {
    id: "run-verification",
    enforcedBy: "src/verification/run-verifier.ts",
    summary:
        "The fully-merged branch is built and tested once by the host after integration.",
    announce: (ctx) => {
        if (ctx.hostRunsWholeTreeVerification !== true) return null
        return [
            "VERIFICATION SCOPE [gate:run-verification]:",
            "- Your duty is your story's perimeter: the test commands your story",
            "  declares, plus targeted tests covering the files you changed.",
            "- Do NOT run the repository's full test suites. The host proves the",
            "  fully-merged tree once, after integration — a full-suite pass from",
            "  your worktree costs its entire runtime under load and adds no",
            "  proof the run gate does not already own. The shell REFUSES",
            "  repository-wide suite commands (bare `npm test`, unfiltered",
            "  `cargo test`, repo-wide test globs) in this mode.",
            "- A whole-tree regression is the integration gate's verdict to give,",
            "  not yours to pre-empt mid-story.",
        ].join("\n")
    },
}

/** Spawn-stage gates: need per-story context the base prompt does not have. */
export const SPAWN_GATES: readonly GateDisclosure[] = [
    WRITE_SURFACE,
    RUN_VERIFICATION,
]

export const ALL_GATES: readonly GateDisclosure[] = [
    ...BASE_GATES,
    ...SPAWN_GATES,
]

export function announceGates(
    gates: readonly GateDisclosure[],
    ctx: GateAnnounceContext,
): string[] {
    return gates
        .map((gate) => gate.announce(ctx))
        .filter((text): text is string => Boolean(text))
}
