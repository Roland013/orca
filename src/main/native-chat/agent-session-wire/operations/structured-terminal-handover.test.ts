import { afterEach, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { recordConversationKey } from '../../conversation-adoption/structured-conversation-key'
import { StructuredTerminalHandoverFences } from '../../conversation-adoption/structured-terminal-handover-fence'

// "Continue in terminal" in place hands the chat's own conversation to a terminal, so the chat's
// agent must be gone first and must stay gone: never two writers on one conversation.
const OWNED = { probeOwner: async () => ({ outcome: 'pid-absent' as const }) }
let rig: QueuedMessageTestRig | null = null
afterEach(async () => {
  await rig?.dispose()
  rig = null
})

function conversationKey(record: AgentSessionRecord) {
  const head = record.providerHandleChain.at(-1)
  const key = head ? recordConversationKey(record, head) : null
  if (!key) {
    throw new Error('expected a conversation')
  }
  return key
}

async function chatWithTurn(
  fences: StructuredTerminalHandoverFences,
  state: 'running' | 'completed'
): Promise<QueuedMessageTestRig> {
  // Claude: the agent whose chats hand their conversation to a terminal.
  const chat = await createQueuedMessageTestRig({
    ...OWNED,
    agent: 'claude',
    // The runtime's start admission, reduced to the fence: no terminal has reported here.
    hostDeps: {
      assertNoTerminalWriter: async (record) => {
        if (
          record.providerHandleChain.length > 0 &&
          fences.holds(conversationKey(record), () => [])
        ) {
          throw new Error('a terminal took this conversation over')
        }
      }
    }
  })
  const id = await chat.workingSend()
  const turnId = `turn-${id}`
  await chat.settleAccepted(id, id)
  chat
    .providerEvents()
    .appendItem(
      { provider: 'claude', sessionId: THREAD, uuid: turnId },
      state === 'running'
        ? { kind: 'turn', turnId, state, userItemId: `orca:${id}` }
        : { kind: 'turn', turnId, state, outcome: 'success', userItemId: `orca:${id}` },
      { turnScope: { kind: 'thread' } }
    )
  chat.providerEvents().publish()
  await chat.providerEvents().written?.()
  return chat
}

function handOver(chat: QueuedMessageTestRig, fences: StructuredTerminalHandoverFences) {
  return chat.host.handOverToTerminal(SESSION, () => {
    const id = fences.hold('claude', conversationKey(chat.store.getRecord(SESSION)!))
    return () => fences.release(id)
  })
}

const child = (chat: QueuedMessageTestRig) =>
  chat.host.collaboratorsForTests().sessions.get(SESSION)?.child ?? null

it('never stops a chat whose turn is still running', async () => {
  const fences = new StructuredTerminalHandoverFences()
  rig = await chatWithTurn(fences, 'running')
  expect(await handOver(rig, fences)).toEqual({ ok: false, reason: 'turnActive' })
  expect(child(rig)).not.toBeNull()
  expect(fences.holds(conversationKey(rig.store.getRecord(SESSION)!), () => [])).toBe(false)
})

it('stops an idle chat with proof, and starts no agent for it until the terminal reports', async () => {
  const fences = new StructuredTerminalHandoverFences()
  rig = await chatWithTurn(fences, 'completed')
  const startsBefore = rig.starts.mock.calls.length
  expect(await handOver(rig, fences)).toEqual({ ok: true })
  expect(child(rig)).toBeNull()
  expect(rig.store.getRecord(SESSION)?.lease).toMatchObject({ claimStatus: 'released' })
  // A send from another client in the gap before the terminal reports: its start is refused.
  await rig.send('from the phone').result
  await eventually(async () => expect(await rig!.drafts()).toMatchObject([{ state: 'returned' }]))
  expect(child(rig)).toBeNull()
  expect(rig.starts.mock.calls.length).toBe(startsBefore)
})
