import type { AiVaultChatTerminalHandoverRefusal } from '../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { isAgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionLeaseNeverAcquired } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import {
  listStructuredProviderSessionOwnership,
  sameIdTerminalResumeEnabled,
  terminalResumeBlocked
} from '../host/structured-provider-session-ownership'
import { readHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import { recordConversationKey } from '../../conversation-adoption/structured-conversation-key'
import { terminalHandoverFences } from '../../conversation-adoption/structured-terminal-handover-fence'

type TerminalHandoverHost = Pick<
  StructuredAgentSessionMutationContext,
  'deps' | 'sessions' | 'readChildWork' | 'childWorkOpen' | 'serialize' | 'conversation'
> & {
  /** The idle sweep's early release, made even while a client views the chat. */
  releaseIdle: (sessionId: string) => Promise<void>
}

type Refused = { ok: false; reason: AiVaultChatTerminalHandoverRefusal }

/** `handoverId` names the fence that keeps every other writer off until the terminal reports. */
export type StructuredTerminalHandover = { ok: true; handoverId: string } | Refused

const COMMAND_REASONS: ReadonlySet<string> = new Set<AiVaultChatTerminalHandoverRefusal>([
  'turnActive',
  'promptPending',
  'backgroundTasksRunning',
  'messagesUnsettled',
  'rewindUnconfirmed',
  'handoffInFlight'
])

/** Stop an idle chat's agent with proof it exited, so a terminal can resume its conversation.
 *  Refused untouched while the chat works (the /clear check) or a terminal already holds the
 *  conversation (the chat-start check). The fence is held on the chat's lane before the stop, so
 *  no start or second hand-over slips in after it; every refusal releases it. */
export async function handOverStructuredChatToTerminal(
  host: TerminalHandoverHost,
  sessionId: string
): Promise<StructuredTerminalHandover> {
  await host.conversation(sessionId)
  const admitted = await host.serialize(
    sessionId,
    async (): Promise<StructuredTerminalHandover> => {
      const reason =
        (await workBlocksHandover(host, sessionId)) ??
        (await terminalHoldsConversation(host, sessionId))
      const record = host.deps.store.requireWritableRecord(sessionId)
      const head = record.providerHandleChain.at(-1)
      const key = head ? recordConversationKey(record, head) : null
      if (reason || !key?.id) {
        return { ok: false, reason: reason ?? 'stopUnproven' }
      }
      return { ok: true, handoverId: terminalHandoverFences.hold(record.provider, key, 'handover') }
    }
  )
  if (!admitted.ok) {
    return admitted
  }
  const release = () => terminalHandoverFences.release(admitted.handoverId)
  try {
    // The idle sweep's own stop: it rechecks owed work and asks the provider before stopping.
    await host.releaseIdle(sessionId)
    const reason = await host.serialize(sessionId, async () => stopUnproven(host, sessionId))
    if (reason) {
      release()
      return { ok: false, reason }
    }
    return admitted
  } catch (error) {
    release()
    throw error
  }
}

async function workBlocksHandover(
  host: TerminalHandoverHost,
  sessionId: string
): Promise<AiVaultChatTerminalHandoverRefusal | null> {
  const session = host.sessions.get(sessionId)
  const record = host.deps.store.requireWritableRecord(sessionId)
  if (!session) {
    return 'agentBusy'
  }
  if (session.child?.phase === 'starting') {
    return 'agentStarting'
  }
  const blocked = await conversationCommandBlocked(
    {
      sessionId,
      fence: record.lease.runtimeFence,
      journal: session.journal,
      adapter: host.deps.adapter,
      readWork: (operation) =>
        readHostStructuredAgentSessionWork(
          { store: host.deps.store, sessions: host.sessions },
          sessionId,
          operation
        )
    },
    record,
    { views: host.readChildWork(sessionId), open: host.childWorkOpen(sessionId) },
    session.child ? undefined : 'at-rest'
  )
  if (!blocked) {
    return null
  }
  const reason = blocked.code === 'agent_session_operation_invalid' ? blocked.details?.reason : null
  return isCommandReason(reason) ? reason : 'agentBusy'
}

function isCommandReason(
  reason: string | null | undefined
): reason is AiVaultChatTerminalHandoverRefusal {
  return reason != null && COMMAND_REASONS.has(reason)
}

/** The check a chat start makes: a fence, an open resumed terminal or a live terminal writer. */
async function terminalHoldsConversation(
  host: TerminalHandoverHost,
  sessionId: string
): Promise<AiVaultChatTerminalHandoverRefusal | null> {
  try {
    await host.deps.assertNoTerminalWriter?.(host.deps.store.requireWritableRecord(sessionId))
    return null
  } catch (error) {
    if (isAgentSessionRefusalError(error) && error.refusal.code === 'agent_session_conflict') {
      return 'openInTerminal'
    }
    throw error
  }
}

/** The terminal is admitted by the same rule as any same-id resume: the head's owner exited. A
 *  chat whose agent never started has no owner to prove gone. */
function stopUnproven(
  host: TerminalHandoverHost,
  sessionId: string
): AiVaultChatTerminalHandoverRefusal | null {
  if (host.sessions.get(sessionId)?.child) {
    return 'agentBusy'
  }
  const record = host.deps.store.getRecord(sessionId)
  const view = host.deps.store.getConversation(sessionId)
  const head = view
    ? listStructuredProviderSessionOwnership([view]).find((link) => link.role === 'head')
    : undefined
  if (!record || !head) {
    return 'stopUnproven'
  }
  const neverStarted =
    sameIdTerminalResumeEnabled(head.provider) && agentSessionLeaseNeverAcquired(record.lease)
  return terminalResumeBlocked(head) && !neverStarted ? 'stopUnproven' : null
}
