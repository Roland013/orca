import { afterEach, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
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
import { holdTerminalResumedConversation } from '../../../ipc/pty/pane/resumed-conversation-hold'
import { terminalConversationHolds } from '../../conversation-adoption/structured-terminal-conversation-holds'
import { setStructuredAgentSessionHost } from '../host/structured-agent-session-registry'
import {
  assertLegacyAiVaultResumeAllowed,
  assertLegacyAiVaultResumeCommandAllowed
} from '../../../ai-vault/structured-sessions/structured-session-ownership'

// "Continue in terminal" hands a Claude chat's own conversation to a terminal. Never two writers
// on it: not the chat and the terminal, not two terminals. Nothing here rests on hooks naming a
// process, which Windows hooks never do.
let rig: QueuedMessageTestRig | null = null
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = null
})

/** What the runtime sees: the hook rows, and whether each PTY still runs. */
const runtime: { rows: AgentStatusIpcPayload[]; ptys: Map<string, boolean> } = {
  rows: [],
  ptys: new Map()
}

/** The terminal's hook row as Windows writes it: no agent process. */
const windowsRow: AgentStatusIpcPayload = {
  paneKey: 'terminal-tab:leaf-1',
  connectionId: null,
  receivedAt: HOST_TEST_NOW,
  stateStartedAt: HOST_TEST_NOW,
  state: 'working',
  prompt: '',
  agentType: 'claude',
  providerSession: { key: 'session_id', id: THREAD }
}
/** The row a quit agent leaves while its shell stays open (toRetainedProviderSessionRow), as the
 *  runtime reads it. */
const leftoverRow: AgentStatusIpcPayload = {
  ...windowsRow,
  state: 'done',
  providerSessionOnly: true
}

async function idleClaudeChat(): Promise<QueuedMessageTestRig> {
  const chat = await createQueuedMessageTestRig({
    probeOwner: async () => ({ outcome: 'pid-absent' as const }),
    agent: 'claude',
    // A later start resumes the saved conversation, as Claude's --resume does.
    restartable: true,
    hostDeps: {
      // Production's check, wired as the runtime wires it.
      assertNoTerminalWriter: (record) =>
        assertChatConversationFreeOfTerminals(
          {
            rows: () => runtime.rows,
            // As the hook server reads a row with no process: unverifiable.
            observation: () => ({
              current: () => true,
              presence: async () => null,
              topology: 'pane-owned'
            }),
            ptyConnected: (ptyId) => runtime.ptys.get(ptyId)
          },
          record
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

it('never lets a chat and a terminal, or two terminals, write one Claude conversation', async () => {
  rig = await idleClaudeChat()
  setStructuredAgentSessionHost(rig.host)
  const first = await rig.host.handOverToTerminal(SESSION)
  if (!first.ok) {
    throw new Error(`the idle chat was refused: ${first.reason}`)
  }
  expect(owner(rig)).toBeNull()
  // Before the terminal's PTY spawns, the hand-over holds the conversation.
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // The PTY spawns resuming it and its agent reports the Windows way. The PTY alone holds now.
  runtime.ptys.set('pty-1', true)
  holdTerminalResumedConversation({
    agent: 'claude',
    providerSession: { key: 'session_id', id: THREAD },
    ptyId: 'pty-1',
    connectionId: null
  })
  terminalConversationHolds.releaseHandover(first.handoverId)
  runtime.rows = [windowsRow]
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // A send from another client starts no agent for the chat.
  await rig.send('from the phone').result
  await eventually(async () => expect(await rig!.drafts()).toMatchObject([{ state: 'returned' }]))
  expect(owner(rig)).toBeNull()
  // A same-id resume sent to a terminal, or from Session History, stays refused as before.
  await expect(
    assertLegacyAiVaultResumeCommandAllowed(`claude --resume ${THREAD}`, async () => {})
  ).rejects.toThrow()
  expect(() =>
    assertLegacyAiVaultResumeAllowed({
      agent: 'claude',
      sessionId: THREAD,
      filePath: `/private-fixture/claude/projects/workspace/${THREAD}.jsonl`,
      codexHome: null,
      executionHostId: 'local'
    })
  ).toThrow()
  // The agent quits but its shell stays: the PTY still runs, so the hold stays.
  runtime.rows = [leftoverRow]
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // The terminal closes. Its leftover row holds nothing; the chat writes again.
  runtime.ptys.set('pty-1', false)
  await rig.send('back in the chat').result
  await eventually(() => expect(owner(rig!)).not.toBeNull())
})
