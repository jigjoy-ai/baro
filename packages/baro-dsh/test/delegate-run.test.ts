import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DelegateRun,
  composeObservers,
  type RunProcess,
  type RunProcessPort,
  type RunRequest,
  type RunView,
} from '../src/application/delegate-run.ts'
import type { Terminal } from '../src/domain/run.ts'

/* The use case against fake ports: a scripted stdout and a recording
   observer. No dsh, no process — that is the point of the ports. */

function scripted(lines: string[], exitCode: number | null): { port: RunProcessPort; terminated: () => boolean; started: () => RunRequest | undefined } {
  let terminated = false
  let started: RunRequest | undefined
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const process: RunProcess = {
    lines: (async function* () {
      for (const line of lines) yield line
      release?.()
    })(),
    exited: gate.then(() => ({ exitCode })),
    terminate: () => {
      terminated = true
    },
    waitForExit: async () => undefined,
  }
  return {
    port: {
      start(request) {
        started = request
        return process
      },
    },
    terminated: () => terminated,
    started: () => started,
  }
}

function request(goal = 'add a slugify helper'): RunRequest {
  return { goal, cwd: '/tmp/repo', label: 'slugify', runId: 'run-1', signal: new AbortController().signal }
}

describe('DelegateRun', () => {
  it('follows the stream and reports a completed outcome to the observer', async () => {
    const child = scripted(
      [
        '{"type":"init","protocol":3,"project":"demo","stories":[{"id":"S1"}]}',
        'garbage line',
        '{"type":"activity","text":"not a milestone"}',
        '{"type":"story_complete","id":"S1"}',
        '{"type":"done","success":true,"stats":{"stories_completed":1,"stories_skipped":0}}',
      ],
      0,
    )
    const seen: { view?: RunView; terminal?: Terminal; changes: number } = { changes: 0 }
    const delegate = new DelegateRun(child.port, {
      opened(view) {
        seen.view = view
        return {
          changed: () => {
            seen.changes += 1
          },
          closed: terminal => {
            seen.terminal = terminal
          },
        }
      },
    })
    const outcome = await delegate.start(request()).outcome
    assert.equal(outcome.terminal, 'completed')
    assert.equal(seen.terminal, 'completed')
    assert.equal(seen.view?.id, 'run-1')
    assert.equal(seen.view?.label, 'slugify')
    assert.equal(seen.changes, 4, 'three milestones plus the activity line; the garbage line moves nothing')
    assert.match(seen.view?.progress() ?? '', /project: demo/)
    assert.match(outcome.text, /baro run succeeded/)
    assert.equal(child.started()?.runId, 'run-1')
  })

  it('maps a token ceiling to max-tokens and a dead child to error', async () => {
    const ceiling = scripted(['{"type":"done","success":false,"abort_code":"token_ceiling"}'], 1)
    assert.equal((await new DelegateRun(ceiling.port, undefined).start(request()).outcome).terminal, 'max-tokens')
    const dead = scripted([], 137)
    assert.equal((await new DelegateRun(dead.port, undefined).start(request()).outcome).terminal, 'error')
  })

  it('cancel terminates the child and ends as aborted', async () => {
    const child = scripted(['{"type":"init","protocol":3,"stories":[]}'], null)
    const delegation = new DelegateRun(child.port, undefined).start(request())
    delegation.cancel('user')
    assert.equal(child.terminated(), true)
    assert.equal((await delegation.outcome).terminal, 'aborted')
  })

  it('a failing observer neither orphans the child nor fails the delegation', async () => {
    const child = scripted(['{"type":"done","success":true}'], 0)
    const failures: unknown[] = []
    const delegate = new DelegateRun(
      child.port,
      {
        opened() {
          throw new Error('no job controller serves this agent')
        },
      },
      error => failures.push(error),
    )
    const outcome = await delegate.start(request()).outcome
    assert.equal(outcome.terminal, 'completed')
    assert.equal(failures.length, 1)
    assert.notEqual(child.started(), undefined)
  })

  it('composed observers are isolated from each other', async () => {
    const closedBy: string[] = []
    const failures: unknown[] = []
    const observer = composeObservers(
      [
        { opened: () => { throw new Error('panel down') } },
        { opened: () => ({ closed: () => closedBy.push('jobs') }) },
        { opened: () => ({ changed: () => { throw new Error('flaky') }, closed: () => closedBy.push('flaky') }) },
      ],
      error => failures.push(error),
    )
    const child = scripted(['{"type":"progress","completed":1,"total":1}', '{"type":"done","success":true}'], 0)
    const outcome = await new DelegateRun(child.port, observer).start(request()).outcome
    assert.equal(outcome.terminal, 'completed')
    assert.deepEqual(closedBy, ['jobs', 'flaky'])
    assert.equal(failures.length, 1 + 2, 'one open failure, one changed failure per milestone')
  })

  it('refuses an empty goal before touching the process', () => {
    const child = scripted([], 0)
    assert.throws(() => new DelegateRun(child.port, undefined).start(request('   ')), /needs a goal/)
    assert.equal(child.started(), undefined)
  })
})
