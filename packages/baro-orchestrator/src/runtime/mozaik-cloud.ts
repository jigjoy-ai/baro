import { createCloudExporter } from "@mozaik-ai/cloud-sdk/exporter"

import type { AgenticEnvironment } from "./mozaik-runtime.js"

const DEFAULT_ENDPOINT = "https://api.app.jigjoy.ai"
const END_DEADLINE_MS = 5_000

export interface MozaikCloudLink {
    readonly sessionId: string
    end(): Promise<void>
}

export interface MozaikCloudOptions {
    env?: NodeJS.ProcessEnv
    log?: (line: string) => void
    fetch?: typeof fetch
    endDeadlineMs?: number
}

/**
 * Joins the mozaik cloud exporter to a run's runtime. Opt-in only
 * (BARO_MOZAIK_CLOUD=1 plus MOZAIK_API_KEY): bus payloads carry repository
 * content, so a key that happens to be set must not start an upload.
 */
export function linkMozaikCloud(
    environment: AgenticEnvironment,
    options: MozaikCloudOptions = {},
): MozaikCloudLink | null {
    const env = options.env ?? process.env
    const log = options.log ?? ((line) => process.stderr.write(`${line}\n`))
    if (env.BARO_MOZAIK_CLOUD !== "1") return null
    const projectKey = env.MOZAIK_API_KEY
    if (!projectKey) {
        log("[mozaik-cloud] BARO_MOZAIK_CLOUD=1 but MOZAIK_API_KEY is unset; not exporting")
        return null
    }
    const exporter = createCloudExporter({
        endpoint: env.MOZAIK_CLOUD_ENDPOINT || DEFAULT_ENDPOINT,
        projectKey,
        participants: () => environment.runtime.state.getParticipants(),
        // stdout is the TUI protocol; the exporter's default banner would corrupt it.
        onSessionUrl: (url) => log(`[mozaik-cloud] watching live: ${url}`),
        onError: (error, dropped) => log(`[mozaik-cloud] ${error.message} (${dropped} event(s) dropped)`),
        ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    environment.admit(exporter.participant)
    return {
        sessionId: exporter.sessionId,
        async end() {
            let timer: NodeJS.Timeout | undefined
            const deadline = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, options.endDeadlineMs ?? END_DEADLINE_MS)
                timer.unref()
            })
            try {
                await Promise.race([exporter.end(), deadline])
            } finally {
                clearTimeout(timer)
                environment.dismiss(exporter.participant)
            }
        },
    }
}
