import { normalizeAgentProviderSession } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { sameIdTerminalResumeEnabled } from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import { terminalConversationHolds } from '../../../native-chat/conversation-adoption/structured-terminal-conversation-holds'

/** A local PTY Orca spawned to resume a conversation (its spawn names it) or reattached to one (its
 *  pane's saved record names it) holds that conversation while it runs, so the chat that owns it
 *  can't start a second writer. Only agents whose chats hand conversations to terminals. */
export function holdTerminalResumedConversation(resumed: {
  agent: unknown
  providerSession: unknown
  ptyId: string
  connectionId: string | null | undefined
}): void {
  const providerSession = normalizeAgentProviderSession(resumed.providerSession)
  if (
    !resumed.connectionId &&
    typeof resumed.agent === 'string' &&
    sameIdTerminalResumeEnabled(resumed.agent) &&
    providerSession?.id
  ) {
    terminalConversationHolds.holdPty(resumed.agent, providerSession.id, resumed.ptyId)
  }
}
