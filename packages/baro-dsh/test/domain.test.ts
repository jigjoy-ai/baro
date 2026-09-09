import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isMilestone, parseLine } from '../src/domain/protocol.ts'
import { RunTracker, classifyDone, renderOutcome, renderProgress, resolveTerminal } from '../src/domain/run.ts'

describe('protocol', () => {
  it('parses only JSON objects with a string type', () => {
    assert.equal(parseLine('not json'), null)
    assert.equal(parseLine('{"no":"type"}'), null)
    assert.equal(parseLine('[1,2]'), null)
    assert.deepEqual(parseLine(' {"type":"progress","completed":1,"total":3} '), { type: 'progress', completed: 1, total: 3 })
  })

  it('splits milestone from live feed by type', () => {
    assert.equal(isMilestone({ type: 'critique' }), true)
    assert.equal(isMilestone({ type: 'activity' }), false)
    assert.equal(isMilestone({ type: 'token_usage' }), false)
  })
})

describe('run', () => {
  it('classifies done by success first, then the one code it knows', () => {
    assert.equal(classifyDone({ type: 'done', success: true }), 'completed')
    assert.equal(classifyDone({ type: 'done', success: false, abort_code: 'token_ceiling' }), 'max-tokens')
    assert.equal(classifyDone({ type: 'done', success: false, abort_code: 'shell_timeout' }), 'error')
    assert.equal(classifyDone({ type: 'done', success: false }), 'error')
  })

  it('a run whose stories all merged with verification passed is delivered, not failed', () => {
    const done = {
      type: 'done',
      success: false,
      abort_reason: 'global goal is not satisfied (G-A1, G-C2): 2 open invariant(s)',
      verification_status: 'passed',
      stats: { stories_completed: 3, stories_skipped: 0, total_commits: 6, files_created: 4, files_modified: 1 },
    }
    assert.equal(classifyDone(done), 'completed')
    const tracker = new RunTracker()
    tracker.accept(done)
    const text = renderOutcome(tracker.summary(), 'completed')
    assert.match(text, /^baro run delivered: every story merged and verification passed/)
    assert.match(text, /open contract: global goal is not satisfied/)
    assert.match(text, /commits: 6/)
    assert.match(text, /files created: 4, modified: 1/)
    // One skipped story or a failed verification keeps the honest error.
    assert.equal(classifyDone({ ...done, stats: { ...done.stats, stories_skipped: 1 } }), 'error')
    assert.equal(classifyDone({ ...done, verification_status: 'failed' }), 'error')
  })

  it('resolves a terminal without a done line from the exit code', () => {
    assert.equal(resolveTerminal(true, 0, undefined), 'aborted')
    assert.equal(resolveTerminal(false, 0, undefined), 'completed')
    assert.equal(resolveTerminal(false, 1, undefined), 'error')
    assert.equal(resolveTerminal(false, 1, { type: 'done', success: true }), 'completed')
  })

  it('folds the stream into a bounded summary', () => {
    const tracker = new RunTracker(3)
    tracker.accept({ type: 'init', protocol: 3, project: 'demo', stories: [{ id: 'S1' }, { id: 'S2' }] })
    tracker.accept({ type: 'activity', text: 'noise' })
    tracker.accept({ type: 'story_start', id: 'S1', ts: '2026-09-07T10:00:01.000Z' })
    tracker.accept({ type: 'progress', completed: 1, total: 2 })
    tracker.accept({ type: 'push_status', pr_url: 'https://example.test/pr/1' })
    tracker.accept({ type: 'done', success: true, stats: { stories_completed: 2, stories_skipped: 0 } })
    const summary = tracker.summary()
    assert.equal(summary.protocol, 3)
    assert.equal(summary.project, 'demo')
    assert.equal(summary.storiesTotal, 2)
    assert.deepEqual([summary.completed, summary.total], [1, 2])
    assert.equal(summary.prUrl, 'https://example.test/pr/1')
    assert.equal(summary.milestones.length, 3, 'oldest milestone dropped past the limit')
    assert.match(summary.milestones.at(-1) ?? '', /^done success$/)
    assert.match(renderProgress(summary), /^phase: done\nactivity: noise\nproject: demo\nprogress: 1\/2\npr: https/)
    const text = renderOutcome(summary, 'completed')
    assert.match(text, /^baro run succeeded\./)
    assert.match(text, /stories completed: 2, skipped: 0/)
    assert.match(text, /pull request: https/)
  })

  it('follows the phases the stream announces before the first milestone', () => {
    const tracker = new RunTracker()
    assert.equal(tracker.summary().phase, 'intake')
    tracker.accept({ type: 'architect_start' })
    assert.equal(tracker.summary().phase, 'architect')
    const r1 = tracker.summary().revision
    tracker.accept({ type: 'story_log', id: 'plan', line: 'drafting stories' })
    assert.equal(tracker.summary().activity, 'drafting stories')
    assert.ok(tracker.summary().revision > r1, 'an activity line moves the revision')
    tracker.accept({ type: 'plan_fragment', stories: [{ id: 'S1', title: 'Title case' }, { id: 'S2', title: 'Truncate' }] })
    assert.equal(tracker.summary().phase, 'planning')
    assert.equal(tracker.summary().storiesTotal, 2)
    assert.match(tracker.summary().activity ?? '', /^plan: Title case, Truncate/)
    tracker.accept({ type: 'init', protocol: 3, project: 'p', stories: [{ id: 'S1' }, { id: 'S2' }] })
    assert.equal(tracker.summary().phase, 'executing')
    tracker.accept({ type: 'activity', id: 'S1', kind: 'tool_call', text: 'npm test' })
    assert.equal(tracker.summary().activity, 'S1: npm test')
    const r2 = tracker.summary().revision
    tracker.accept({ type: 'activity', id: 'S1', kind: 'tool_call', text: 'npm test' })
    assert.equal(tracker.summary().revision, r2, 'a repeated line is not a change')
    tracker.accept({ type: 'finalize_start' })
    assert.equal(tracker.summary().phase, 'finalizing')
    tracker.accept({ type: 'done', success: true })
    assert.equal(tracker.summary().phase, 'done')
    assert.match(renderProgress(tracker.summary()), /^phase: done\n/)
  })

  it('renders a failure with its code and reason', () => {
    const tracker = new RunTracker()
    tracker.accept({ type: 'done', success: false, abort_code: 'token_ceiling', abort_reason: 'S2 ran out of context' })
    const text = renderOutcome(tracker.summary(), 'max-tokens')
    assert.match(text, /^baro run failed \(token_ceiling\)\.\nS2 ran out of context/)
  })

  it('names the terminal when no done line arrived', () => {
    assert.match(renderOutcome(new RunTracker().summary(), 'error'), /ended without a result \(error\)/)
  })
})
