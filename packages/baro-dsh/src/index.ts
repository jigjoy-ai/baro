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
// cordis has no optional injection; all five are in dsh-base.
export const inject = ['subagents', 'subprocess', 'jobs', 'settings', 'systemPrompt']

/* dsh's delegation tool carries a fixed description, so the one place to tell
   the model what baro is for is a prompt section. It is a run, not a helper:
   minutes of planning and verification that only pay off past one small edit. */
export const DELEGATION_GUIDANCE = `\
The "baro" tool delegates a goal to baro, an autonomous run that plans the goal into stories, executes them in parallel with coding agents, reviews each story independently, and verifies the merged result. A run takes 10–30 minutes and returns a certified outcome, not a chat reply.
Use "baro" for goals that span several files or need more than one coherent change, where a plan, parallel execution and independent verification are worth the wait. For a single small edit, a question, or an investigation, do the work yourself or use the ordinary subagent. Give baro the full goal in one prompt; it does not see this conversation.`

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
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'baro:delegation',
      order: 400,
      text: DELEGATION_GUIDANCE.replaceAll('"baro"', `"${resolved.providerName ?? 'baro'}"`),
    }),
  )
}
