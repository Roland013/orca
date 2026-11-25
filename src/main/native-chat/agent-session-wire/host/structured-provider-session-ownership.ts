import type {
  AgentSessionOwnerObservation,
  AgentSessionConversationView
} from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { agentSessionOwnerObservationVerdict } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import { structuredAgentRuntimeMetadata } from '../../../runtime/agent-session/installation/structured-agent-runtime-metadata'
import {
  keysMayMatch,
  recordConversationKey,
  type ConversationKey
} from '../../conversation-adoption/structured-conversation-key'

export type StructuredProviderSessionOwnership = {
  wslDistro: string | null
  sessionId: string
  workspaceId: string
  provider: StructuredAgentId
  providerSessionId: string
  conversationName?: string
  ownerObservation: AgentSessionOwnerObservation
  /** `head`: the conversation the chat continues now; `earlier`: one its chain held before. */
  role: 'head' | 'earlier'
  key: ConversationKey
}

/** Use registration-defined History row IDs for both ownership display and duplicate-adoption checks. */
export function listStructuredProviderSessionOwnership(
  records: readonly AgentSessionConversationView[]
): StructuredProviderSessionOwnership[] {
  return records.flatMap((record) => {
    const history = structuredAgentRuntimeMetadata(record.provider)?.sessionHistory
    const head = record.providerHandleChain.at(-1)
    const headKey = head ? recordConversationKey(record, head) : null
    return history && headKey
      ? record.providerHandleChain.flatMap((link) => {
          const key = recordConversationKey(record, link)
          return key
            ? [
                {
                  sessionId: record.sessionId,
                  wslDistro: record.location.wslDistro,
                  workspaceId: record.location.workspaceId,
                  provider: record.provider,
                  providerSessionId: history.rowSessionId(link),
                  conversationName: record.conversationName,
                  ownerObservation: record.ownerObservation,
                  // A repeat resume link of the head's id is the head too.
                  role: keysMayMatch(key, headKey) ? ('head' as const) : ('earlier' as const),
                  key
                }
              ]
            : []
        })
      : []
  })
}

/** Fail closed: only a lease released on proof its owner exited can't be writing. */
export function agentSessionLeasePossiblyWriting(lease: AgentSessionOwnerObservation): boolean {
  return agentSessionOwnerObservationVerdict(lease) !== 'exited'
}

/** Agents whose chats can hand their conversation to a terminal once the chat stopped writing.
 *  Claude's `--resume` keeps the id, and Orca holds the conversation for the PTY it spawns. */
export function sameIdTerminalResumeEnabled(provider: StructuredAgentId): boolean {
  return provider === 'claude'
}

/** Whether a sent or History terminal resume of this link's conversation is refused: always, as
 *  before same-id hand-overs. Only Orca's own hand-over admits one (handoverTerminalResumeBlocked):
 *  Orca spawns that terminal and holds the conversation while its PTY runs. */
export function terminalResumeBlocked(_holding: StructuredProviderSessionOwnership): boolean {
  return true
}

/** Whether the hand-over may give this link's conversation to a terminal: never for agents that
 *  don't hand conversations over, and for the head only once its owner is proven gone. */
export function handoverTerminalResumeBlocked(
  holding: StructuredProviderSessionOwnership
): boolean {
  return (
    !sameIdTerminalResumeEnabled(holding.provider) ||
    (holding.role === 'head' && agentSessionLeasePossiblyWriting(holding.ownerObservation))
  )
}
