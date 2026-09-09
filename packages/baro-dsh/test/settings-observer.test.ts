import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SettingsObserver, type RunRecord, type RunsDocument } from '../src/adapters/dsh/settings-observer.ts'
import type { RunView } from '../src/application/delegate-run.ts'
import { RunTracker } from '../src/domain/run.ts'

function harness() {
  let doc: RunsDocument = { runs: {} }
  const writes: RunsDocument[] = []
  let clock = 1_000
  const timers: Array<{ at: number; fn: () => void }> = []
  const observer = new SettingsObserver(
    {
      get: () => doc,
      update: async patch => {
        doc = { runs: patch.runs }
        writes.push(doc)
      },
    },
    error => {
      throw error
    },
    {
      throttleMs: 1_000,
      keepFinished: 1,
      tail: 2,
      now: () => clock,
      setTimeout: (fn, ms) => {
        timers.push({ at: clock + ms, fn })
        return 0
      },
    },
  )
  const advance = (ms: number) => {
    clock += ms
    for (const t of timers.splice(0).filter(t => t.at <= clock)) t.fn()
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  return { observer, writes, doc: () => doc, advance, flush }
}

function view(id: string, tracker: RunTracker): RunView {
  return {
    id,
    label: `goal ${id}`,
    startedAt: '2026-09-07T10:00:00.000Z',
    summary: () => tracker.summary(),
    progress: () => '',
    cancel: () => undefined,
  }
}

describe('SettingsObserver', () => {
  it('writes on open, throttles changes, writes on close', async () => {
    const h = harness()
    const tracker = new RunTracker()
    const sub = h.observer.opened(view('run-1', tracker))
    await h.flush()
    assert.equal(h.writes.length, 1)
    assert.equal(h.doc().runs['run-1']?.status, 'running')

    tracker.accept({ type: 'progress', completed: 1, total: 3 })
    sub.changed?.()
    sub.changed?.()
    await h.flush()
    assert.equal(h.writes.length, 1, 'inside the throttle window nothing is written yet')
    h.advance(1_000)
    await h.flush()
    assert.equal(h.writes.length, 2)
    assert.deepEqual([h.doc().runs['run-1']?.completed, h.doc().runs['run-1']?.total], [1, 3])

    tracker.accept({ type: 'done', success: true })
    sub.closed('completed')
    await h.flush()
    const final = h.doc().runs['run-1'] as RunRecord
    assert.equal(final.status, 'completed')
    assert.ok(final.finishedAt)
    assert.equal(final.milestones.length, 2, 'tail keeps the newest two lines')
  })

  it('keeps only the newest finished runs', async () => {
    const h = harness()
    for (const id of ['a', 'b', 'c']) {
      const sub = h.observer.opened(view(id, new RunTracker()))
      h.advance(10)
      sub.closed('error')
      await h.flush()
    }
    assert.deepEqual(Object.keys(h.doc().runs), ['c'])
  })
})
