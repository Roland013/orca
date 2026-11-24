import type { AiVaultChatTerminalHandoverRefusal } from '../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import {
  listStructuredProviderSessionOwnership,
  terminalResumeBlocked
} from '../host/structured-provider-session-ownership'
import { readHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import { conversationCommandBlocked } from './structured-conversation-command-admission'

type TerminalHandoverHost = Pick<
  StructuredAgentSessionMutationContext,
  'deps' | 'sessions' | 'readChildWork' | 'childWorkOpen' | 'serialize' | 'conversation'
> & {
  /** The idle sweep's early release, made even while a client views the chat. */
  releaseIdle: (sessionId: string) => Promise<void>
}

export type StructuredTerminalHandover =
  | { ok: true }
  | { ok: false; reason: AiVaultChatTerminalHandoverRefusal }

const WORK_REASONS: ReadonlySet<string> = new Set<AiVaultChatTerminalHandoverRefusal>([
  'turnActive',
  'promptPending',
  'backgroundTasksRunning',
  'messagesUnsettled'
])

/** Stop an idle chat's agent with proof it exited, so a terminal can resume its conversation.
 *  `holdFence` runs on the chat's lane before the stop, so no start slips in after it; every
 *  refusal releases it. Busy chats are refused untouched, by the same check as /clear. */
export async function handOverStructuredChatToTerminal(
  host: TerminalHandoverHost,
  sessionId: string,
  holdFence: () => () => void
): Promise<StructuredTerminalHandover> {
  await host.conversation(sessionId)
  const admitted = await host.serialize(
    sessionId,
    async (): Promise<
      { ok: false; reason: AiVaultChatTerminalHandoverRefusal } | { ok: true; release: () => void }
    > => {
      const reason = await workBlocksHandover(host, sessionId)
      return reason ? { ok: false, reason } : { ok: true, release: holdFence() }
    }
  )
  if (!admitted.ok) {
    return admitted
  }
  const { release } = admitted
  try {
    // The idle sweep's own stop: it rechecks owed work and asks the provider before stopping.
    await host.releaseIdle(sessionId)
    const reason = await host.serialize(sessionId, async () => stopUnproven(host, sessionId))
    if (reason) {
      release()
      return { ok: false, reason }
    }
    return { ok: true }
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
  if (!session || session.child?.phase === 'starting') {
    return 'busy'
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
  return isWorkReason(reason) ? reason : 'busy'
}

function isWorkReason(
  reason: string | null | undefined
): reason is AiVaultChatTerminalHandoverRefusal {
  return reason != null && WORK_REASONS.has(reason)
}

/** The terminal is admitted by the same rule as any same-id resume: the head's owner exited. */
function stopUnproven(
  host: TerminalHandoverHost,
  sessionId: string
): AiVaultChatTerminalHandoverRefusal | null {
  if (host.sessions.get(sessionId)?.child) {
    return 'busy'
  }
  const view = host.deps.store.getConversation(sessionId)
  const head = view
    ? listStructuredProviderSessionOwnership([view]).find((link) => link.role === 'head')
    : undefined
  return !head || terminalResumeBlocked(head) ? 'stopUnproven' : null
}
