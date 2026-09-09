import { createInterface } from 'node:readline'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { RunProcess, RunProcessPort, RunRequest } from '../../application/delegate-run.js'

/* Runs `baro <goal> --headless` through dsh's subprocess service. The parent
   env is scrubbed by dsh; credentials reach the child only through `env`. */

export interface BaroCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly localOnly: boolean
  readonly env: Readonly<Record<string, string>>
  readonly disposeGraceMs: number
}

export class SubprocessRunner implements RunProcessPort {
  constructor(
    private readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
    private readonly baro: BaroCommand,
  ) {}

  start(request: RunRequest): RunProcess {
    const argv = [
      this.baro.command,
      request.goal,
      '--headless',
      '--cwd',
      request.cwd,
      ...(this.baro.localOnly ? ['--local-only'] : []),
      ...this.baro.args,
    ]
    // stdin must be closed, not merely silent: headless baro answers its own
    // intake questions only once stdin hits EOF, and blocks on an open pipe.
    const child = this.spawn({
      argv,
      cwd: request.cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
      graceMs: this.baro.disposeGraceMs,
      signal: request.signal,
      env: { ...this.baro.env, BARO_RUN_ID: request.runId },
    })
    return {
      lines: lines(child.stdout),
      exited: child.done.then(outcome => ({ exitCode: outcome.exitCode })),
      terminate: () => child.terminate(),
      waitForExit: () => child.waitForExit(),
    }
  }
}

async function* lines(stream: NodeJS.ReadableStream | undefined): AsyncIterable<string> {
  if (!stream) return
  yield* createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
}
