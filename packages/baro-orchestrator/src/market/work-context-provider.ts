import type { Participant } from "../runtime/mozaik.js"

import {
    CollaborationNote,
    WorkContextProvided,
    WorkContextRequested,
} from "../semantic-events.js"
import {
    SerializedObserver,
    type SerializedEventContext,
    type SerializedObserverFailure,
} from "../runtime/serialized-observer.js"

export interface WorkContextSource {
    gatherContext(
        storyId: string,
        hints?: readonly string[],
    ): string | null | Promise<string | null>
}

interface RetainedCollaborationNote {
    sourceAgentId: string
    text: string
}

const MAX_RETAINED_NOTES = 32
const MAX_NOTE_CHARS = 2_000
const MAX_NOTE_CONTEXT_CHARS = 8_000

export class WorkContextProvider extends SerializedObserver {
    private requestAuthority: Participant | null = null
    private collaborationAuthority: Participant | null = null
    private readonly retainedNotes: RetainedCollaborationNote[] = []

    constructor(
        private readonly runId: string,
        private readonly source: WorkContextSource | null,
        private readonly timeoutMs = 30_000,
    ) {
        super()
    }

    setRequestAuthority(authority: Participant): void {
        if (this.requestAuthority && this.requestAuthority !== authority) {
            throw new Error("work context request authority is already bound")
        }
        this.requestAuthority = authority
    }

    setCollaborationAuthority(authority: Participant): void {
        if (
            this.collaborationAuthority &&
            this.collaborationAuthority !== authority
        ) {
            throw new Error("work context collaboration authority is already bound")
        }
        this.collaborationAuthority = authority
    }

    protected override handleEvent(context: SerializedEventContext): void {
        const { event } = context
        if (CollaborationNote.is(event) && event.data.runId === this.runId) {
            if (
                !this.collaborationAuthority ||
                context.source !== this.collaborationAuthority
            ) {
                return
            }
            this.retainNote(event.data.sourceAgentId, event.data.text)
            return
        }
        if (!WorkContextRequested.is(event) || event.data.runId !== this.runId) {
            return
        }
        if (!this.requestAuthority || context.source !== this.requestAuthority) return
        // Freeze the note set at request time. A note emitted after the Board
        // requested this story's launch context belongs to a later turn/wave.
        const retainedNotes = this.retainedNotes.map((note) => ({ ...note }))
        context.spawnTask(
            {
                label: `gather context for ${event.data.storyId}`,
                key: event.data.storyId,
            },
            async () => {
                let gathered: string | null = null
                try {
                    gathered = this.source
                        ? await withTimeout(
                              this.source.gatherContext(
                                  event.data.storyId,
                                  event.data.hints,
                              ),
                              this.timeoutMs,
                          )
                        : null
                } catch (error) {
                    process.stderr.write(
                        `[work-context] ${event.data.storyId}: ${(error as Error)?.message ?? String(error)}\n`,
                    )
                }
                const launchContext = mergeLaunchContext(
                    gathered,
                    retainedNotes,
                )
                context.publish(
                    WorkContextProvided.create({
                        runId: this.runId,
                        requestId: event.data.requestId,
                        storyId: event.data.storyId,
                        context: launchContext,
                    }),
                )
            },
        )
    }

    protected override onManagedFailure(failure: SerializedObserverFailure): void {
        process.stderr.write(`[work-context] ${failure.error.message}\n`)
    }

    private retainNote(sourceAgentId: string, rawText: string): void {
        const text = rawText.trim().slice(0, MAX_NOTE_CHARS)
        if (!text) return
        const duplicate = this.retainedNotes.some(
            (note) => note.sourceAgentId === sourceAgentId && note.text === text,
        )
        if (duplicate) return
        this.retainedNotes.push({ sourceAgentId, text })
        if (this.retainedNotes.length > MAX_RETAINED_NOTES) {
            this.retainedNotes.splice(
                0,
                this.retainedNotes.length - MAX_RETAINED_NOTES,
            )
        }
    }
}

function mergeLaunchContext(
    gathered: string | null,
    notes: readonly RetainedCollaborationNote[],
): string | null {
    const sourceContext = gathered?.trim() || null
    const noteContext = formatRetainedNotes(notes)
    if (!sourceContext) return noteContext
    if (!noteContext) return sourceContext
    return `${sourceContext}\n\n${noteContext}`
}

function formatRetainedNotes(
    notes: readonly RetainedCollaborationNote[],
): string | null {
    if (notes.length === 0) return null

    // Prefer the most recent findings when the bounded prompt budget is full,
    // then restore chronological order for readability.
    const selected: RetainedCollaborationNote[] = []
    let used = 0
    for (let index = notes.length - 1; index >= 0; index -= 1) {
        const note = notes[index]!
        const rendered = renderNote(note)
        if (selected.length > 0 && used + rendered.length > MAX_NOTE_CONTEXT_CHARS) {
            continue
        }
        selected.push(note)
        used += rendered.length
        if (used >= MAX_NOTE_CONTEXT_CHARS) break
    }
    selected.reverse()
    if (selected.length === 0) return null
    return [
        "## Shared findings from earlier agents",
        "",
        ...selected.map(renderNote),
    ].join("\n")
}

function renderNote(note: RetainedCollaborationNote): string {
    const text = note.text.replace(/\r?\n/g, "\n  ")
    return `- [${note.sourceAgentId}] ${text}`
}

async function withTimeout<T>(value: T | Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
        return await Promise.race([
            Promise.resolve(value),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`context lookup timed out after ${timeoutMs}ms`)),
                    timeoutMs,
                )
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}
