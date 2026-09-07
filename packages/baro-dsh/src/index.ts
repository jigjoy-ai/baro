import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { JobsObserver } from './adapters/dsh/jobs-observer.js'
import { BaroSubagentProvider } from './adapters/dsh/subagent-provider.js'
import { SubprocessRunner } from './adapters/dsh/subprocess-runner.js'
import { DelegateRun } from './application/delegate-run.js'

export { DelegateRun } from './application/delegate-run.js'
export type { RunObserverPort, RunProcessPort, RunRequest, RunView } from './application/delegate-run.js'
export { MILESTONE_TYPES, isMilestone, parseLine } from './domain/protocol.js'
export { RunTracker, classifyDone, resolveTerminal } from './domain/run.js'

/* Composition root: the dsh plugin wires dsh's services into the ports and
   registers the provider. Everything else in this package is dsh-free. */

export const name = 'baro-dsh'
// cordis has no optional injection; `jobs` is in dsh-base, so requiring it costs nothing.
export const inject = ['subagents', 'subprocess', 'jobs']

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

export function apply(ctx: Context, config: Config): void {
  const resolved = Config(config)
  const runner = new SubprocessRunner(spec => ctx.subprocess.spawn(spec), {
    command: resolved.command ?? 'baro',
    args: resolved.args ?? [],
    localOnly: resolved.localOnly ?? true,
    env: resolved.env ?? {},
    disposeGraceMs: resolved.disposeGraceMs ?? 5_000,
  })
  const provider = new BaroSubagentProvider(
    resolved.providerName ?? 'baro',
    new DelegateRun(runner, new JobsObserver(ctx.jobs)),
    resolved.cwd,
  )
  ctx.effect(() => ctx.subagents.registerProvider(provider))
}
