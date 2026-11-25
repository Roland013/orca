import { agentSessionOwnerObservationIsLive } from '../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import { isAgentSessionRefusalError } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  terminalResumeBlocked,
  type StructuredProviderSessionOwnership
} from '../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import { terminalHandoverFences } from '../../native-chat/conversation-adoption/structured-terminal-handover-fence'

/** A same-id terminal resume of chats' conversations is refused while a chat may write one, or a
 *  terminal already holds it (the chat-start check). Admitted heads are fenced, since the terminal
 *  writes before Orca sees it there. */
export async function admitTerminalResume(
  owners: readonly StructuredProviderSessionOwnership[],
  targetless: boolean
): Promise<void> {
  const blocking = owners.find((ownership) => targetless || terminalResumeBlocked(ownership))
  if (blocking) {
    refuseLegacyWriter(blocking)
  }
  const deps = getStructuredAgentSessionHost()?.deps
  const heads = owners.filter((ownership) => ownership.role === 'head')
  for (const head of heads) {
    const record = deps?.store.getRecord(head.sessionId)
    if (record) {
      await deps?.assertNoTerminalWriter?.(record, 'resume').catch((error: unknown) => {
        throw isAgentSessionRefusalError(error) && error.refusal.code === 'agent_session_conflict'
          ? new Error('This conversation is already open in a terminal. Close that terminal first.')
          : error
      })
    }
  }
  heads.forEach(({ provider, key }) => terminalHandoverFences.hold(provider, key, 'resume'))
}

function refuseLegacyWriter(ownership: StructuredProviderSessionOwnership): never {
  throw new Error(
    agentSessionOwnerObservationIsLive(ownership.ownerObservation)
      ? 'agent_session_conflict'
      : 'agent_session_ownership_unknown'
  )
}
