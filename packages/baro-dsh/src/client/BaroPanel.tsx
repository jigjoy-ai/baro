import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RunRecord } from '../adapters/dsh/settings-observer.js'
import type { Phase } from '../domain/run.js'
import type { RunsStore } from './store.js'
import type { BaroKey } from './locales.js'

/* Sidebar footer trigger plus a panel listing baro runs. Styled with dsh's
   own alias tokens so it follows the light and dark themes; styles are
   injected once because CSS modules need their in-tree build helper. */

export interface BaroPanelProps {
  readonly wide?: boolean
  readonly store: RunsStore
  readonly t: (key: BaroKey) => string
}

const STYLE_ID = 'baro-dsh-panel'
const CSS = `
.baro-trigger{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:6px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;text-align:left}
.baro-trigger:hover,.baro-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.baro-mark{display:inline-grid;grid-template-columns:5px 5px;gap:1.5px;flex:none}
.baro-mark i{display:block;width:5px;height:5px;border-radius:1.5px;background:var(--dsw-alias-label-tertiary)}
.baro-mark i:nth-child(1),.baro-mark i:nth-child(4){background:var(--dsw-alias-brand-primary)}
.baro-badge{margin-left:auto;min-width:18px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff);font-size:11px;line-height:18px;text-align:center}
.baro-panel{position:fixed;left:12px;bottom:56px;z-index:60;width:400px;max-width:calc(100vw - 24px);max-height:72vh;overflow:auto;padding:12px;border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.18));border:1px solid var(--dsw-alias-border-l1);font-size:12px}
.baro-panel h3{display:flex;align-items:center;justify-content:space-between;margin:2px 4px 10px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.baro-run{padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);margin-bottom:8px}
.baro-run+.baro-run{margin-top:8px}
.baro-head{display:flex;align-items:center;gap:8px;min-width:0}
.baro-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:13px}
.baro-pill{flex:none;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:18px;border:1px solid transparent}
.baro-pill[data-s="running"]{color:var(--dsw-alias-state-warn-label,#b45309);background:var(--dsw-alias-state-warn-tertiary,rgba(245,158,11,.14));border-color:var(--dsw-alias-state-warn-secondary,rgba(245,158,11,.35))}
.baro-pill[data-s="completed"]{color:var(--dsw-alias-state-success-primary,#15803d);background:var(--dsw-alias-state-success-tertiary,rgba(34,197,94,.14));border-color:var(--dsw-alias-state-success-secondary,rgba(34,197,94,.35))}
.baro-pill[data-s="error"],.baro-pill[data-s="max-tokens"]{color:var(--dsw-alias-state-error-primary,#b91c1c);background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.12));border-color:var(--dsw-alias-state-error-secondary,rgba(239,68,68,.35))}
.baro-pill[data-s="aborted"]{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1)}
.baro-time{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);font-size:11px}
.baro-steps{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin:10px 0 6px}
.baro-step{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}
.baro-step[data-on="done"]{background:var(--dsw-alias-brand-primary)}
.baro-step[data-on="now"]{background:var(--dsw-alias-brand-primary);opacity:.55;animation:baro-pulse 1.4s ease-in-out infinite}
@keyframes baro-pulse{0%,100%{opacity:.35}50%{opacity:.9}}
.baro-steplabels{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}
.baro-phase{font-size:12px;color:var(--dsw-alias-label-primary)}
.baro-phase b{font-weight:600}
.baro-activity{margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.baro-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.baro-meta a{color:var(--dsw-alias-brand-primary)}
.baro-log-toggle{margin-top:8px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}
.baro-log-toggle:hover{color:var(--dsw-alias-label-primary)}
.baro-log{margin:6px 0 0;padding:8px;list-style:none;border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}
.baro-log li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5}
.baro-empty{padding:8px 4px;color:var(--dsw-alias-label-tertiary)}
`

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

const PHASES: readonly Phase[] = ['intake', 'architect', 'planning', 'executing', 'finalizing']

/** Re-renders once a second while anything is live, so elapsed times tick. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function BaroPanel({ wide, store, t }: BaroPanelProps): JSX.Element | null {
  ensureStyles()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [open, setOpen] = useState(false)
  const now = useTicker(open && snapshot.running > 0)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target && !target.closest('.baro-panel') && !target.closest('.baro-trigger')) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open])

  if (!snapshot.read || (snapshot.runs.length === 0 && !snapshot.error)) return null

  return (
    <>
      <button type="button" className="baro-trigger" aria-label={t('trigger.aria')} aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="baro-mark"><i /><i /><i /><i /></span>
        {wide !== false && <span>{t('panel.title')}</span>}
        {snapshot.running > 0 && <span className="baro-badge">{snapshot.running}</span>}
      </button>
      {open && (
        <div className="baro-panel" role="dialog" aria-label={t('panel.aria')}>
          <h3>
            <span>{t('panel.title')}</span>
            {snapshot.running > 0 && <span>{snapshot.running} {t('status.running')}</span>}
          </h3>
          {snapshot.error && <div className="baro-empty">{t('panel.error')}: {snapshot.error}</div>}
          {snapshot.runs.length === 0 && !snapshot.error && <div className="baro-empty">{t('panel.empty')}</div>}
          {snapshot.runs.map(([id, run]) => (
            <RunCard key={id} run={run} now={now} t={t} />
          ))}
        </div>
      )}
    </>
  )
}

function RunCard({ run, now, t }: { run: RunRecord; now: number; t: (key: BaroKey) => string }): JSX.Element {
  const [showLog, setShowLog] = useState(false)
  const live = run.status === 'running'
  const phase: Phase | undefined = run.phase && PHASES.includes(run.phase) ? run.phase : run.phase === 'done' ? 'done' : undefined
  const phaseIndex = phase === 'done' ? PHASES.length : phase ? PHASES.indexOf(phase) : -1
  const total = run.total > 0 ? run.total : 0
  const pct = total > 0 ? Math.min(100, Math.round((run.completed / total) * 100)) : run.status === 'completed' ? 100 : 0
  const statusKey = `status.${run.status}` as BaroKey
  const log = run.milestones ?? []

  return (
    <div className="baro-run">
      <div className="baro-head">
        <span className="baro-title" title={run.label}>{run.label}</span>
        <span className="baro-pill" data-s={run.status}>{t(statusKey)}</span>
        <span className="baro-time">{elapsed(run, now)}</span>
      </div>

      <div className="baro-steps" aria-hidden="true">
        {PHASES.map((p, i) => (
          <span key={p} className="baro-step" data-on={i < phaseIndex || run.status === 'completed' ? 'done' : i === phaseIndex && live ? 'now' : 'todo'} />
        ))}
      </div>
      <div className="baro-steplabels" aria-hidden="true">
        {PHASES.map(p => <span key={p}>{p}</span>)}
      </div>

      {live && (
        <div className="baro-phase">
          <b>{phase ? t(`phase.${phase}` as BaroKey) : t('phase.intake')}</b>
          {total > 0 && <span> · {t('run.progress')} {run.completed}/{total}{pct > 0 ? ` (${pct}%)` : ''}</span>}
        </div>
      )}
      {live && run.activity && <div className="baro-activity" title={run.activity}>{run.activity}</div>}

      <div className="baro-meta">
        {!live && total > 0 && <span>{t('run.progress')} {run.completed}/{total}</span>}
        {run.project && <span>{run.project}</span>}
        {run.prUrl && <a href={run.prUrl} target="_blank" rel="noreferrer">{t('run.pr')}</a>}
      </div>

      {log.length > 0 && (
        <>
          <button type="button" className="baro-log-toggle" onClick={() => setShowLog(v => !v)} aria-expanded={showLog}>
            {showLog ? '▾' : '▸'} {t('run.milestones')} ({log.length})
          </button>
          {showLog && (
            <ul className="baro-log" aria-label={t('run.milestones')}>
              {log.slice(-8).map((line, i) => <li key={i} title={line}>{line}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function elapsed(run: RunRecord, now: number): string {
  const start = Date.parse(run.startedAt)
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return mins < 60 ? `${mins}m ${String(secs % 60).padStart(2, '0')}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}
