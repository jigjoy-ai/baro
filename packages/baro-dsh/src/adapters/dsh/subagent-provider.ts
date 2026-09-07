import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { DelegateRun, DelegationOutcome } from '../../application/delegate-run.js'

/* dsh's remote, fire-and-return provider seam over the delegation use case.
   Nothing of the live feed reaches the model; the job is where a human
   watches, the result is what the model reads. */

const DIAGNOSTIC_LIMIT = 4000

export class BaroSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly delegate: DelegateRun,
    private readonly configuredCwd: string | undefined,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const goal = promptText(request.prompt)
    const cwd = resolveChildCwd(this.name, this.configuredCwd, request.parent.session.header.cwd)
    const id = brandString<SessionId>(randomUUID())
    const delegation = this.delegate.start({
      goal,
      cwd,
      label: request.label ?? truncate(goal, 80),
      runId: id,
      signal: request.signal,
    })
    return {
      id,
      localAgent: undefined,
      result: delegation.outcome.then(toResult),
      dispose: () => delegation.dispose(),
    }
  }
}

function toResult(outcome: DelegationOutcome): SubagentResult {
  const stopReason: SubagentStopReason = outcome.terminal
  const done = outcome.summary.done
  return {
    output: [{ type: 'text', text: outcome.text } satisfies ContentBlock],
    structured: done
      ? {
          success: done.success === true,
          abortCode: typeof done.abort_code === 'string' ? done.abort_code : null,
          prUrl: outcome.summary.prUrl ?? null,
        }
      : undefined,
    diagnostic: stopReason === 'completed' ? undefined : truncate(outcome.text, DIAGNOSTIC_LIMIT),
    stopReason,
  }
}

function promptText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
