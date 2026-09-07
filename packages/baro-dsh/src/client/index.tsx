import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RunsDocument } from '../adapters/dsh/settings-observer.js'
import { BaroPanel } from './BaroPanel.js'
import { en, NS, zh, type BaroKey } from './locales.js'
import { RunsStore } from './store.js'

/* Browser half of the plugin. Reads run state the host wrote into the
   `baro-dsh` settings namespace, refreshes on the forwarded update event,
   and renders a footer action in the sidebar. Value imports stay inside dsh's
   browser baseline (React, Cordis); everything from dsh is type-only. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    baro: BaroKey
  }
}

const RUNS_SETTINGS_NS = 'baro-dsh'

export const inject = ['slots', 'locale', 'remote']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'baro-dsh: dictionaries')

  const store = new RunsStore(async (): Promise<RunsDocument | null> => {
    const answered = await ctx.remote.settings.describe()
    if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
    const view = answered.value.namespaces.find((entry: { ns: string; value: unknown }) => entry.ns === RUNS_SETTINGS_NS)
    return view ? (view.value as unknown as RunsDocument) : null
  })

  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns: string) => {
        if (ns === RUNS_SETTINGS_NS) void store.refresh()
      }),
      ctx.on('connection/reset', () => {
        store.reset()
        void store.refresh()
      }),
    ]
    void store.refresh()
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'baro-dsh: run state')

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'baro-panel',
        locale: NS,
        inject: () => ({ store }),
      },
      BaroPanel as never,
    ),
  )
}
