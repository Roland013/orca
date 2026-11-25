import { afterEach, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentProcessVerdict } from '../../../../shared/agent-status/process/agent-process-presence'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { assertChatConversationFreeOfTerminals } from '../../../runtime/agent-session/lifecycle/structured-agent-cli-writers'
import { terminalHandoverFences } from '../../conversation-adoption/structured-terminal-handover-fence'

// "Continue in terminal" hands the chat's own conversation to a terminal. Never two writers on it:
// not the chat and the terminal, not two terminals (a second hand-over of the reopened chat).
let rig: QueuedMessageTestRig | null = null
afterEach(async () => {
  await rig?.dispose()
  rig = null
})

/** The terminal the conversation went to, as the runtime sees it: its status row, its agent
 *  process, and whether its PTY still runs. */
const terminal: { rows: AgentStatusIpcPayload[]; agent: AgentProcessVerdict; running: boolean } = {
  rows: [],
  agent: 'live',
  running: true
}

function terminalRow(spawnRowOnly: boolean): AgentStatusIpcPayload {
  return {
    paneKey: 'terminal-tab:leaf-1',
    connectionId: null,
    receivedAt: HOST_TEST_NOW,
    stateStartedAt: HOST_TEST_NOW,
    state: spawnRowOnly ? 'done' : 'working',
    prompt: '',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: THREAD },
    ...(spawnRowOnly ? { providerSessionOnly: true } : {})
  }
}

async function idleClaudeChat(): Promise<QueuedMessageTestRig> {
  const chat = await createQueuedMessageTestRig({
    probeOwner: async () => ({ outcome: 'pid-absent' as const }),
    agent: 'claude',
    // A later start resumes the saved conversation, as Claude's --resume does.
    restartable: true,
    hostDeps: {
      // Production's check, wired as the runtime wires it.
      assertNoTerminalWriter: (record, admitting) =>
        assertChatConversationFreeOfTerminals(
          {
            rows: () => terminal.rows,
            // A spawn's resume row names no process yet, as in production.
            observation: (row) => ({
              current: () => true,
              presence: async () => (row.providerSessionOnly ? null : terminal.agent),
              topology: 'pane-owned'
            }),
            paneRunning: () => terminal.running
          },
          record,
          admitting
        )
    }
  })
  const id = await chat.workingSend()
  const turnId = `turn-${id}`
  await chat.settleAccepted(id, id)
  chat
    .providerEvents()
    .appendItem(
      { provider: 'claude', sessionId: THREAD, uuid: turnId },
      { kind: 'turn', turnId, state: 'completed', outcome: 'success', userItemId: `orca:${id}` },
      { turnScope: { kind: 'thread' } }
    )
  chat.providerEvents().publish()
  await chat.providerEvents().written?.()
  return chat
}

const IN_TERMINAL = { ok: false, reason: 'openInTerminal' }
const owner = (chat: QueuedMessageTestRig) => chat.store.getRecord(SESSION)?.lease.ownerProcess

it('never lets a chat and a terminal, or two terminals, write one conversation', async () => {
  rig = await idleClaudeChat()
  const first = await rig.host.handOverToTerminal(SESSION)
  if (!first.ok) {
    throw new Error(`the idle chat was refused: ${first.reason}`)
  }
  expect(owner(rig)).toBeNull()
  // Before the terminal's agent reports, the hand-over's fence holds the conversation.
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // A restart loses the fence; the restored terminal's spawn row holds while its PTY runs.
  terminalHandoverFences.release(first.handoverId)
  terminal.rows = [terminalRow(true)]
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // Its agent reported: the live process holds it.
  terminal.rows = [terminalRow(false)]
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // A send from another client starts no agent for the chat.
  await rig.send('from the phone').result
  await eventually(async () => expect(await rig!.drafts()).toMatchObject([{ state: 'returned' }]))
  expect(owner(rig)).toBeNull()
  // Once the terminal's agent ended, the chat writes again.
  terminal.agent = 'exited'
  await rig.send('back in the chat').result
  await eventually(() => expect(owner(rig!)).not.toBeNull())
})
