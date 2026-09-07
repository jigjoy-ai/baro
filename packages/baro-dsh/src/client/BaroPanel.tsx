import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RunRecord } from '../adapters/dsh/settings-observer.js'
import type { RunsStore } from './store.js'
import type { BaroKey } from './locales.js'

/* Sidebar footer trigger plus a popover listing baro runs: status, story
   progress, last milestones, pull request. Styles are injected once — CSS
   modules need dsh's build helper, which an out-of-tree plugin does not have. */

export interface BaroPanelProps {
  readonly wide?: boolean
  readonly store: RunsStore
  readonly t: (key: BaroKey) => string
}

const STYLE_ID = 'baro-dsh-panel'
const CSS = `
.baro-trigger{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.baro-trigger:hover{background:rgba(127,127,127,.12)}
.baro-mark{display:inline-block;width:10px;height:10px;border-radius:3px;background:#f59e0b;flex:none}
.baro-badge{margin-left:auto;min-width:18px;padding:0 6px;border-radius:9px;background:#f59e0b;color:#111;font-size:11px;line-height:18px;text-align:center}
.baro-pop{position:fixed;left:64px;bottom:56px;width:360px;max-height:70vh;overflow:auto;padding:10px;border-radius:12px;background:var(--dsw-surface,#1c1f26);color:var(--dsw-fg,#e6e8ee);box-shadow:0 12px 40px rgba(0,0,0,.4);border:1px solid rgba(127,127,127,.25);z-index:60;font-size:12px}
.baro-pop h3{margin:2px 4px 8px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.7}
.baro-run{padding:8px;border-radius:8px;border:1px solid rgba(127,127,127,.18);margin-bottom:8px}
.baro-run-head{display:flex;align-items:center;gap:8px}
.baro-dot{width:8px;height:8px;border-radius:50%;flex:none}
.baro-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.baro-status{opacity:.7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.baro-bar{height:4px;margin:8px 0 4px;border-radius:2px;background:rgba(127,127,127,.2);overflow:hidden}
.baro-bar i{display:block;height:100%;background:#f59e0b}
.baro-meta{display:flex;gap:10px;opacity:.75;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.baro-meta a{color:inherit}
.baro-log{margin:6px 0 0;padding:0;list-style:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.85}
.baro-log li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.baro-empty{padding:8px;opacity:.7}
`

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

const DOT: Record<RunRecord['status'], string> = {
  running: '#f59e0b',
  completed: '#22c55e',
  error: '#ef4444',
  'max-tokens': '#ef4444',
  aborted: '#a3a3a3',
}

export function BaroPanel({ wide, store, t }: BaroPanelProps): JSX.Element | null {
  ensureStyles()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!snapshot.read || (snapshot.runs.length === 0 && !snapshot.error)) return null

  return (
    <>
      <button type="button" className="baro-trigger" aria-label={t('trigger.aria')} aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="baro-mark" />
        {wide !== false && <span>{t('panel.title')}</span>}
        {snapshot.running > 0 && <span className="baro-badge">{snapshot.running}</span>}
      </button>
      {open && (
        <div className="baro-pop" role="dialog" aria-label={t('panel.aria')}>
          <h3>{t('panel.title')}</h3>
          {snapshot.error && <div className="baro-empty">{t('panel.error')}: {snapshot.error}</div>}
          {snapshot.runs.length === 0 && !snapshot.error && <div className="baro-empty">{t('panel.empty')}</div>}
          {snapshot.runs.map(([id, run]) => (
            <RunCard key={id} run={run} t={t} />
          ))}
        </div>
      )}
    </>
  )
}

function RunCard({ run, t }: { run: RunRecord; t: (key: BaroKey) => string }): JSX.Element {
  const pct = run.total > 0 ? Math.min(100, Math.round((run.completed / run.total) * 100)) : run.status === 'completed' ? 100 : 0
  return (
    <div className="baro-run">
      <div className="baro-run-head">
        <span className="baro-dot" style={{ background: DOT[run.status] }} />
        <span className="baro-label" title={run.label}>{run.label}</span>
        <span className="baro-status">{t(`status.${run.status}` as BaroKey)} · {elapsed(run)}</span>
      </div>
      <div className="baro-bar"><i style={{ width: `${pct}%` }} /></div>
      <div className="baro-meta">
        {run.total > 0 && <span>{t('run.progress')} {run.completed}/{run.total}</span>}
        {run.project && <span>{run.project}</span>}
        {run.prUrl && <a href={run.prUrl} target="_blank" rel="noreferrer">{t('run.pr')}</a>}
      </div>
      {run.milestones.length > 0 && (
        <ul className="baro-log" aria-label={t('run.milestones')}>
          {run.milestones.slice(-5).map((line, i) => <li key={i} title={line}>{line}</li>)}
        </ul>
      )}
    </div>
  )
}

function elapsed(run: RunRecord): string {
  const start = Date.parse(run.startedAt)
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now()
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}
