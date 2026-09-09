import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SubprocessRunner } from '../src/adapters/dsh/subprocess-runner.ts'

function recordingSpawn(): { spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle; specs: SubprocessSpawnSpec[] } {
  const specs: SubprocessSpawnSpec[] = []
  const spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    specs.push(spec)
    return {
      stdin: undefined,
      stdout: new PassThrough(),
      stderr: undefined,
      done: new Promise(() => {}),
      terminate: () => {},
      waitForExit: async () => undefined,
    } as unknown as SubprocessHandle
  }
  return { spawn, specs }
}

describe('SubprocessRunner', () => {
  const baro = { command: 'baro', args: ['--llm', 'claude'], localOnly: true, env: { HOME: '/h' }, disposeGraceMs: 5 }

  it('spawns headless baro with the goal, cwd and run id', () => {
    const { spawn, specs } = recordingSpawn()
    new SubprocessRunner(spawn, baro).start({ goal: 'add a helper', cwd: '/repo', label: 'helper', runId: 'run-1', signal: new AbortController().signal })
    assert.equal(specs.length, 1)
    assert.deepEqual(specs[0].argv, ['baro', 'add a helper', '--headless', '--cwd', '/repo', '--local-only', '--llm', 'claude'])
    assert.equal(specs[0].cwd, '/repo')
    assert.equal(specs[0].env?.BARO_RUN_ID, 'run-1')
  })

  // A run stalled 20 minutes on an intake question nobody could answer: headless
  // baro decides such questions itself only after stdin reaches EOF.
  it('closes stdin so headless baro resolves intake questions on its own', () => {
    const { spawn, specs } = recordingSpawn()
    new SubprocessRunner(spawn, baro).start({ goal: 'g', cwd: '/repo', label: 'g', runId: 'run-2', signal: new AbortController().signal })
    assert.equal(specs[0].stdio.stdin, 'ignore')
    assert.equal(specs[0].stdio.stdout, 'pipe')
  })
})
