import { conversationCommandInFlight } from './structured-conversation-command-admission'
import { sendStructuredAgentSessionTurn } from './structured-agent-session-host-mutations'
import {
  runStructuredConversationCommand,
  type ConversationCommandParams
} from './structured-conversation-command'
import { runStructuredCompaction } from './structured-conversation-compaction'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import { handOverStructuredChatToTerminal } from './structured-terminal-handover'

export class StructuredConversationCommandController {
  /** Clear changes send context; compaction instead queues ahead of later sends. */
  readonly pending = new Map<string, { key: string; count: number }>()
  constructor(
    private readonly context: () => StructuredAgentSessionMutationContext,
    private readonly host: Pick<
      StructuredAgentSessionHost,
      'waitForSendSettlement' | 'releaseIdleSession'
    >
  ) {}
  /** Refuse only first-run sends during clear; recorded IDs still replay their answers. */
  send = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ): ReturnType<typeof sendStructuredAgentSessionTurn> =>
    sendStructuredAgentSessionTurn(this.context(), caller, params, {
      clearInFlight: this.pending.has(params.envelope.sessionId)
    })

  /** Stop an idle chat's agent with proof it exited, for a terminal to resume its conversation;
   *  refused, like a second command, while /clear runs. */
  handOverToTerminal = (sessionId: string, holdFence: () => () => void) =>
    this.pending.has(sessionId)
      ? Promise.resolve({ ok: false as const, reason: 'busy' as const })
      : handOverStructuredChatToTerminal(
          { ...this.context(), releaseIdle: (id) => this.host.releaseIdleSession(id, true) },
          sessionId,
          holdFence
        )

  run = (caller: StructuredAgentSessionCaller, params: ConversationCommandParams) => {
    if (params.command === 'compact') {
      return runStructuredCompaction(this.context(), this.host, caller, params, {
        clearInFlight: this.pending.has(params.envelope.sessionId)
      })
    }
    const key = JSON.stringify([caller.callerKey, params.envelope.clientOperationId])
    const pending = this.pending.get(params.envelope.sessionId)
    if (pending && pending.key !== key) {
      return Promise.resolve({ ok: false as const, refusal: conversationCommandInFlight() })
    }
    const entry = pending ?? { key, count: 0 }
    entry.count++
    this.pending.set(params.envelope.sessionId, entry)
    return runStructuredConversationCommand(this.context(), caller, params).finally(() => {
      if (--entry.count === 0 && this.pending.get(params.envelope.sessionId) === entry) {
        this.pending.delete(params.envelope.sessionId)
      }
      // Refusals may write no row; wake drafts without waiting for an unrelated commit.
      this.context().wakeQueuedDrain?.(params.envelope.sessionId)
    })
  }
}
