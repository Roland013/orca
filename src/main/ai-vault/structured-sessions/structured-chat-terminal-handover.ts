import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type {
  AiVaultChatTerminalHandoverResult,
  AiVaultSessionResumePreparation
} from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { sameIdTerminalResumeEnabled } from '../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { recordConversationKey } from '../../native-chat/conversation-adoption/structured-conversation-key'
import { terminalHandoverFences } from '../../native-chat/conversation-adoption/structured-terminal-handover-fence'
import { prepareStructuredChatCliFork } from './structured-chat-cli-fork'

/** "Continue in terminal" in place: stop the idle chat's agent, then hand its own conversation to
 *  a terminal. The chat cannot start again until that terminal reports, exits or the fence lapses. */
export async function prepareStructuredChatTerminalHandover(
  sourceChat: { sessionId: string; workspaceId: string },
  prepare: AiVaultSessionResumePreparation
): Promise<AiVaultChatTerminalHandoverResult> {
  const host = getStructuredAgentSessionHost()
  const record = host?.deps.store.getRecord(sourceChat.sessionId)
  const head = record && agentSessionProviderHandleChainHead(record.providerHandleChain)
  const key = record && head ? recordConversationKey(record, head) : null
  if (!host || !record || !head || !key?.id || !sameIdTerminalResumeEnabled(record.provider)) {
    return { kind: 'unsupported' }
  }
  // Every check that can refuse without stopping runs first: location, rewind, saved transcript.
  const prepared = await prepareStructuredChatCliFork({ sourceChat, fork: true }, prepare, {
    sameConversation: true
  })
  const source = prepared.cliForkSource
  if (!source) {
    throw new Error('This chat has no saved conversation available on this host.')
  }
  let handoverId = ''
  const handover = await host.handOverToTerminal(record.sessionId, () => {
    const id = terminalHandoverFences.hold(record.provider, key)
    handoverId = id
    return () => terminalHandoverFences.release(id)
  })
  if (!handover.ok) {
    return { kind: 'refused', reason: handover.reason }
  }
  const current = host.deps.store.getRecord(record.sessionId)
  if (
    !current ||
    agentSessionProviderHandleChainHead(current.providerHandleChain)?.linkId !== head.linkId
  ) {
    terminalHandoverFences.release(handoverId)
    throw new Error('The chat changed before the terminal could take it over.')
  }
  return {
    kind: 'ready',
    handoverId,
    source,
    conversationName: current.conversationName?.trim() || null
  }
}
