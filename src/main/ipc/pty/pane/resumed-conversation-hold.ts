import { normalizeAgentProviderSession } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  listStructuredProviderSessionOwnership,
  sameIdTerminalResumeEnabled
} from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  keysMayMatch,
  terminalConversationKey
} from '../../../native-chat/conversation-adoption/structured-conversation-key'
import { terminalConversationHolds } from '../../../native-chat/conversation-adoption/structured-terminal-conversation-holds'

type ResumedPty = { agent: string; conversationId: string; ptyId: string }

/** PTYs that spawned before the chat host came up (a restore at app start); judged as it does,
 *  before any chat can start. */
const undecided = new Map<string, ResumedPty>()

/** Every local spawn and reattach reports here. A PTY holds its conversation only when it resumes a
 *  chat's head conversation: a hand-over terminal, or the restore of one. Its chat then can't start
 *  a second writer while the PTY runs. Every other PTY, any other agent's and a Claude terminal of
 *  a terminal-only conversation alike, holds nothing, as on main. */
export function holdTerminalResumedConversation(spawned: {
  agent: unknown
  providerSession: unknown
  ptyId: string
  connectionId: string | null | undefined
  /** The same process again (a reload or restart); it keeps what it held. */
  reattach?: true
}): void {
  // A fresh process under a reused PTY id holds nothing its predecessor held.
  if (!spawned.reattach) {
    terminalConversationHolds.forgetPty(spawned.ptyId)
    undecided.delete(spawned.ptyId)
  }
  const providerSession = normalizeAgentProviderSession(spawned.providerSession)
  if (
    spawned.connectionId ||
    typeof spawned.agent !== 'string' ||
    !sameIdTerminalResumeEnabled(spawned.agent) ||
    !providerSession?.id
  ) {
    return
  }
  const resumed = { agent: spawned.agent, conversationId: providerSession.id, ptyId: spawned.ptyId }
  if (!holdIfChatHead(resumed)) {
    undecided.set(resumed.ptyId, resumed)
  }
}

/** False while no chat host can say whose conversation it is. */
function holdIfChatHead(resumed: ResumedPty): boolean {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return false
  }
  const key = terminalConversationKey(resumed.agent, resumed.conversationId)
  const heads = listStructuredProviderSessionOwnership(host.deps.store.listConversations())
  if (heads.some((holding) => holding.role === 'head' && keysMayMatch(holding.key, key))) {
    terminalConversationHolds.holdPty(resumed.agent, resumed.conversationId, resumed.ptyId)
  }
  return true
}

onStructuredAgentSessionHostChanged(() => {
  for (const [ptyId, resumed] of undecided) {
    if (holdIfChatHead(resumed)) {
      undecided.delete(ptyId)
    }
  }
})
