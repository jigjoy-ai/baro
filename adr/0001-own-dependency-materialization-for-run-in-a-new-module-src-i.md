# ADR-0001: Own dependency materialization for __run in a new module src/integration/dependency-materializer.ts

**Status:** Accepted
**Context:** __run is a bare `git worktree add` with no node_modules, so the first verification pays a full `npm install` (verify.ts:566-583). Extending IntegrationWorktree.prepareOnce would change how __run is created, which the goal forbids; extending worktree.ts symlinkDepDirs would change story-worktree behavior. A separate module invoked after prepare keeps both untouched.
**Decision:** Create packages/baro-orchestrator/src/integration/dependency-materializer.ts exporting exactly:

```ts
export interface MaterializeDependenciesOptions {
  hostRoot: string;
  integrationRoot: string;
  signal?: AbortSignal;
  runInstall?: (workspaceDir: string) => Promise<void>;
}
export interface MaterializedWorkspace {
  dir: string;            // absolute, inside integrationRoot
  action: "linked" | "installed" | "skipped";
  reason: string;         // e.g. "lockfile matches host", "lockfile differs from host", "host has no node_modules", "host and worktree are the same directory"
}
export interface MaterializeDependenciesResult {
  workspaces: MaterializedWorkspace[];
}
export async function materializeDependencies(
  options: MaterializeDependenciesOptions,
): Promise<MaterializeDependenciesResult>;
export function npmCachePath(env?: NodeJS.ProcessEnv): string;
```

Behavior:
1. If `canonicalPath(hostRoot) === canonicalPath(integrationRoot)` (reuse `canonicalPath` from integration-worktree.ts — export it if not already exported), return `{ workspaces: [{ dir: integrationRoot, action: "skipped", reason: "host and worktree are the same directory" }] }` and do nothing else.
2. Workspace set = `[integrationRoot, ...workspacePackageDirs(integrationRoot)]`. Do NOT reimplement workspace globbing: export `workspacePackageDirs` from src/verification/verify.ts (verify.ts:319-350) and import it as `import { workspacePackageDirs } from "../verification/verify.js"`.
3. Per workspace dir `d` with host twin `h = join(hostRoot, relative(integrationRoot, d))`:
   - lockfile = first existing of `package-lock.json`, `npm-shrinkwrap.json` in `d`; if neither exists, the workspace inherits the root workspace's match verdict.
   - match = sha256 hex of the lockfile bytes in `d` equals sha256 hex of the same-named file in `h` (node:crypto `createHash("sha256")`). Never compare version fields or mtimes.
   - If match AND `existsSync(join(h, "node_modules"))` AND NOT `existsSync(join(d, "node_modules"))` → link (ADR: see symlink decision) and record `action: "linked"`.
   - If `existsSync(join(d, "node_modules"))` already → `action: "skipped"`, reason `"node_modules already present"`.
   - Otherwise → `runInstall(d)` and record `action: "installed"` with reason `"lockfile differs from host"` or `"host has no node_modules"`.
4. Default `runInstall` runs `runRepositoryCommand("npm", ["ci", "--prefer-offline"], { cwd: workspaceDir, signal })`. On any rejection, throw `new Error(\`npm ci --prefer-offline failed in ${workspaceDir} (npm cache: ${npmCachePath()}): ${message}\`)` preserving `cause`.
5. `npmCachePath(env = process.env)` returns `env.npm_config_cache ?? env.NPM_CONFIG_CACHE ?? join(homedir(), ".npm")`. This function is the single owner of that path string; no other file may recompute it.

Do NOT add any dependency (no fast-glob, no execa). Use node:fs, node:path, node:crypto, node:os only.
**Consequences:** Install for __run moves from lazy verification to explicit preparation, and `runInstall` injection gives tests a seam without spawning npm. `workspacePackageDirs` becomes public API of verify.ts — its containment guard (verify.ts:326-331) keeps returned dirs strictly under integrationRoot. Agents must not duplicate lockfile hashing or the npm cache path elsewhere.
