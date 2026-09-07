import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { JobsObserver } from './adapters/dsh/jobs-observer.js'
import { SettingsObserver, type RunRecord, type RunsDocument } from './adapters/dsh/settings-observer.js'
import { BaroSubagentProvider } from './adapters/dsh/subagent-provider.js'
import { SubprocessRunner } from './adapters/dsh/subprocess-runner.js'
import { DelegateRun, composeObservers } from './application/delegate-run.js'

export { DelegateRun, composeObservers } from './application/delegate-run.js'
export type { RunObserverPort, RunProcessPort, RunRequest, RunSubscription, RunView } from './application/delegate-run.js'
export { MILESTONE_TYPES, isMilestone, parseLine } from './domain/protocol.js'
export { RunTracker, classifyDone, resolveTerminal } from './domain/run.js'
export type { RunRecord, RunsDocument } from './adapters/dsh/settings-observer.js'

/* Composition root: the dsh plugin wires dsh's services into the ports and
   registers the provider. Everything else in this package is dsh-free. */

export const name = 'baro-dsh'
// cordis has no optional injection; all four are in dsh-base.
export const inject = ['subagents', 'subprocess', 'jobs', 'settings']

/** Namespace the browser panel reads; must match `src/client`. */
export const RUNS_SETTINGS_NS = 'baro-dsh'

export interface Config {
  providerName?: string
  command?: string
  args?: string[]
  localOnly?: boolean
  cwd?: string
  env?: Record<string, string>
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default('baro'),
  command: z.string().min(1).default('baro'),
  args: z.array(z.string()).default([]),
  localOnly: z.boolean().default(true),
  cwd: z.string(),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(5_000),
})

const RunsSchema: z<RunsDocument> = z.object({
  runs: z.dict(z.any()).default({}),
}) as unknown as z<RunsDocument>

export function apply(ctx: Context, config: Config): void {
  const resolved = Config(config)
  const warn = (what: string) => (error: unknown) => {
    console.error(`[baro-dsh] ${what}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const runner = new SubprocessRunner(spec => ctx.subprocess.spawn(spec), {
    command: resolved.command ?? 'baro',
    args: resolved.args ?? [],
    localOnly: resolved.localOnly ?? true,
    env: resolved.env ?? {},
    disposeGraceMs: resolved.disposeGraceMs ?? 5_000,
  })

  // The registry refuses a job no controller serves. Our runs are unowned, so
  // this plugin attaches its own controller for the scope it lives in instead
  // of depending on which agent preset happened to load dsh-tool-jobs.
  ctx.effect(() => ctx.jobs.attachController('baro-dsh'))

  const runs = ctx.settings.register(RUNS_SETTINGS_NS, RunsSchema, { base: { runs: {} } })
  const settingsObserver = new SettingsObserver(
    {
      get: () => runs.get(),
      update: patch => runs.update(patch as { runs: Record<string, RunRecord> }),
    },
    warn('run panel state not persisted'),
  )

  const provider = new BaroSubagentProvider(
    resolved.providerName ?? 'baro',
    new DelegateRun(
      runner,
      composeObservers([new JobsObserver(ctx.jobs), settingsObserver], warn('run observer failed')),
      warn('run continues without an observer'),
    ),
    resolved.cwd,
  )
  ctx.effect(() => ctx.subagents.registerProvider(provider))
}
