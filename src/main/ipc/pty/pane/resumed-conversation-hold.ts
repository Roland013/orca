import {
  normalizeAgentProviderSession,
  type SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { isChatTerminalHandoverLaunch } from '../../../../shared/ai-vault/resume/chat-terminal-handover-marker'
import { sameIdTerminalResumeEnabled } from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import { terminalConversationHolds } from '../../../native-chat/conversation-adoption/structured-terminal-conversation-holds'

/** Every local spawn reports here. A PTY holds its conversation when its launch carries the
 *  hand-over's mark (the hand-over terminal itself, or a cold restore that replays its recipe), or
 *  when it resumes the conversation the hand-over terminal in its pane or under its id held: a
 *  cold restore after Claude quit relaunches from the pane's status rows, unmarked. Its chat then
 *  can't start a second writer while the PTY runs. Every other PTY holds nothing, as on main,
 *  whoever owns its conversation later. */
export function holdTerminalResumedConversation(spawned: {
  agent: unknown
  launchConfig: SleepingAgentLaunchConfig | null | undefined
  providerSession: unknown
  ptyId: string
  paneKey: string | null
  connectionId: string | null | undefined
}): void {
  const providerSession = normalizeAgentProviderSession(spawned.providerSession)
  terminalConversationHolds.spawnedPty({
    ptyId: spawned.ptyId,
    paneKey: spawned.paneKey,
    resumes:
      !spawned.connectionId &&
      typeof spawned.agent === 'string' &&
      sameIdTerminalResumeEnabled(spawned.agent) &&
      providerSession?.id
        ? { agent: spawned.agent, conversationId: providerSession.id }
        : null,
    marked: isChatTerminalHandoverLaunch(spawned.launchConfig)
  })
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
