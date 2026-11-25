import {
  normalizeAgentProviderSession,
  type SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { isChatTerminalHandoverLaunch } from '../../../../shared/ai-vault/resume/chat-terminal-handover-marker'
import { sameIdTerminalResumeEnabled } from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import { terminalConversationHolds } from '../../../native-chat/conversation-adoption/structured-terminal-conversation-holds'

/** Every local spawn reports here. A PTY holds its conversation only when its launch carries the
 *  hand-over's mark: the hand-over terminal itself, or a cold restore of it, whose saved recipe
 *  keeps the mark. Its chat then can't start a second writer while the PTY runs. Every other PTY
 *  holds nothing, as on main, whoever owns its conversation later. */
export function holdTerminalResumedConversation(spawned: {
  agent: unknown
  launchConfig: SleepingAgentLaunchConfig | null | undefined
  providerSession: unknown
  ptyId: string
  connectionId: string | null | undefined
}): void {
  // A fresh process under a reused PTY id holds nothing its predecessor held.
  terminalConversationHolds.forgetPty(spawned.ptyId)
  const providerSession = normalizeAgentProviderSession(spawned.providerSession)
  if (
    !spawned.connectionId &&
    typeof spawned.agent === 'string' &&
    sameIdTerminalResumeEnabled(spawned.agent) &&
    isChatTerminalHandoverLaunch(spawned.launchConfig) &&
    providerSession?.id
  ) {
    terminalConversationHolds.holdPty(spawned.agent, providerSession.id, spawned.ptyId)
  }
}

/** Every local reattach and pane adoption reports here: the same process again, after a reload or
 *  a restart, holds what its spawn held, even once its agent quit and its saved recipe is gone. */
export function holdReattachedTerminalConversation(
  ptyId: string,
  connectionId: string | null | undefined
): void {
  if (!connectionId) {
    terminalConversationHolds.reholdPty(ptyId)
  }
}
