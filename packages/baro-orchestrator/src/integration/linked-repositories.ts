import type { PrdLinkedRepository } from "../prd.js"
import { runRepositoryCommand } from "./repository-command.js"

export interface LinkedRepositoryReport {
    repo: PrdLinkedRepository
    /** HEAD now, when it differs from the HEAD recorded at plan time. */
    movedTo?: string
    /** Files in this run's diff that patch the repo's installed package. */
    patchedBy: string[]
}

/**
 * The install-time patch layouts that edit a dependency from its consumer:
 * pnpm (`@s__n@1.patch`), patch-package (`@s+n+1.patch`), yarn berry
 * (`@s-n-npm-1-hash.patch`) and a direct `node_modules` edit.
 */
export function patchesDependency(path: string, pkg: string): boolean {
    const normalized = path.replace(/\\/g, "/")
    if (normalized.includes(`node_modules/${pkg}/`)) return true
    const file = normalized.split("/").pop() ?? ""
    if (!/\.(patch|diff)$/.test(file)) return false
    const flat = (separator: string) => pkg.replace("/", separator)
    return (
        file.startsWith(`${flat("__")}@`) ||
        file.startsWith(`${flat("__")}.`) ||
        file.startsWith(`${flat("+")}+`) ||
        file.startsWith(`${flat("-")}-npm-`)
    )
}

export async function buildLinkedRepositoryReports(
    repos: readonly PrdLinkedRepository[],
    changedPaths: readonly string[],
    readHead: (path: string) => Promise<string | null> = readRepositoryHead,
): Promise<LinkedRepositoryReport[]> {
    return Promise.all(
        repos.map(async (repo) => {
            const head = repo.headSha ? await readHead(repo.path) : null
            const pkg = repo.package
            return {
                repo,
                ...(head && head !== repo.headSha ? { movedTo: head } : {}),
                patchedBy: pkg ? changedPaths.filter((path) => patchesDependency(path, pkg)) : [],
            }
        }),
    )
}

async function readRepositoryHead(path: string): Promise<string | null> {
    try {
        const { stdout } = await runRepositoryCommand("git", ["rev-parse", "HEAD"], { cwd: path })
        return stdout.trim() || null
    } catch {
        return null
    }
}

export function linkedRepositoryLogLines(reports: readonly LinkedRepositoryReport[]): string[] {
    return reports.flatMap(({ repo, movedTo, patchedBy }) => [
        `[finalizer] linked repository ${repo.name} (${repo.path}): no branch, commit or PR from this run`,
        ...(movedTo ? [`[finalizer] ⚠ linked repository ${repo.name} HEAD moved during the run (${short(repo.headSha)} → ${short(movedTo)})`] : []),
        ...(patchedBy.length > 0 ? [`[finalizer] ⚠ this PR patches linked dependency ${repo.package} in place: ${patchedBy.join(", ")}`] : []),
    ])
}

export function renderLinkedRepositoriesSection(
    reports: readonly LinkedRepositoryReport[],
): string[] {
    if (reports.length === 0) return []
    const lines = [
        "## Linked repositories",
        "",
        "baro executed this run only in this repository. No branch, commit or pull request was created in the linked repositories below, so any change they own is **not** delivered by this PR: land it there (source + release/version bump), then consume the new version here.",
        "",
    ]
    for (const { repo, movedTo, patchedBy } of reports) {
        const facts = [
            repo.package ? `package \`${repo.package}\`` : null,
            repo.dependency ? `consumed via ${repo.dependency}` : null,
        ].filter(Boolean)
        lines.push(`- **${repo.name}** — \`${repo.path}\`${facts.length > 0 ? ` (${facts.join("; ")})` : ""}`)
        if (movedTo) {
            lines.push(`  - ⚠ HEAD moved during the run: \`${short(repo.headSha)}\` → \`${short(movedTo)}\` — changes there were made outside this PR; review them separately.`)
        }
        if (patchedBy.length > 0) {
            lines.push(`  - ⚠ This PR patches the installed \`${repo.package}\` instead of its source: ${patchedBy.map((path) => `\`${path}\``).join(", ")}`)
        }
    }
    lines.push("")
    return lines
}

function short(sha: string | undefined): string {
    return sha ? sha.slice(0, 7) : "?"
}
