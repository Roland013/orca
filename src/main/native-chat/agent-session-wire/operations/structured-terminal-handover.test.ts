import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { spawnPtyFromRuntimeController } from '../../../ipc/pty/runtime/spawn'
import { makeRuntimePtySpawnTestDeps } from '../../../ipc/pty/runtime/spawn-preflight-test-deps-fixture'
import { terminalConversationHolds } from '../../conversation-adoption/structured-terminal-conversation-holds'
import { setStructuredAgentSessionHost } from '../host/structured-agent-session-registry'
import { buildAiVaultHandoverStartup } from '../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import {
  assertLegacyAiVaultResumeAllowed,
  assertLegacyAiVaultResumeCommandAllowed
} from '../../../ai-vault/structured-sessions/structured-session-ownership'

// "Continue in terminal" hands a Claude chat's own conversation to a terminal. Never two writers
// on it: not the chat and the terminal, not two terminals. Nothing here rests on hooks naming a
// process, which Windows hooks never do. Only hand-over terminals hold: any other Claude terminal
// keeps main's behavior, even once a chat owns its conversation.
let rig: QueuedMessageTestRig | null = null
let userDataPath: string | null = null
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = null
  await terminalConversationHolds.restore(null)
  if (userDataPath) {
    rmSync(userDataPath, { recursive: true, force: true })
    userDataPath = null
  }
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
// The chat's agent is stopped, so the refusal says Orca can't vouch for who owns the conversation.
const REFUSED = 'agent_session_ownership_unknown'
const LEAF = '00000000-0000-4000-8000-000000000001'
const owner = (chat: QueuedMessageTestRig) => chat.store.getRecord(SESSION)?.lease.ownerProcess

/** The hand-over terminal's launch recipe, as the hand-over builds it; a restore reuses its saved copy. */
const handoverLaunch = buildAiVaultHandoverStartup({
  session: { agent: 'claude', sessionId: THREAD, cwd: null, codexHome: null },
  host: { platform: process.platform, codexHome: null, liveShell: undefined },
  settings: null
})?.launchConfig

/** A fresh Claude PTY as its spawn reports it: the hand-over's launch, or any other. */
function spawned(ptyId: string, conversationId: string | undefined, handover: boolean): void {
  runtime.ptys.set(ptyId, true)
  holdTerminalResumedConversation({
    agent: 'claude',
    launchConfig: handover ? handoverLaunch : { agentArgs: '', agentEnv: {} },
    providerSession: conversationId ? { key: 'session_id', id: conversationId } : undefined,
    ptyId,
    connectionId: null
  })
}

/** A pane adopting its running PTY on a reload or a restart, through the runtime's spawn, as the
 *  pane's stable-owner adoption answers it. */
async function reattached(ptyId: string): Promise<void> {
  runtime.ptys.set(ptyId, true)
  const owner = { handle: `handle-${ptyId}`, tabId: `tab-${ptyId}`, leafId: LEAF, ptyId }
  const result = { id: ptyId, isReattach: true }
  await spawnPtyFromRuntimeController(
    {
      ...makeRuntimePtySpawnTestDeps(),
      adoptStablePane: async () => ({
        result,
        outcome: { kind: 'adopted', result },
        owner,
        materialized: true
      })
    },
    { cols: 80, rows: 24, worktreeId: 'workspace-1', tabId: owner.tabId, leafId: LEAF }
  )
}

/** Orca quits and starts again; the daemon keeps the PTYs, which the new runtime hasn't seen. */
async function restartOrca(): Promise<void> {
  runtime.ptys.clear()
  await terminalConversationHolds.restore(userDataPath)
}

it('never lets two writers on one Claude conversation, and holds only hand-over terminals', async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-terminal-holds-'))
  await terminalConversationHolds.restore(userDataPath)
  rig = await idleClaudeChat()
  setStructuredAgentSessionHost(rig.host)
  // App start. A hand-over terminal of the chat's conversation is cold-restored from its recipe.
  // Another terminal resumes that conversation unmarked: it holds nothing, whoever owns it now.
  spawned('pty-restored', THREAD, true)
  spawned('pty-other', THREAD, false)
  // The restored hand-over terminal holds the chat.
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // A fresh shell reuses its PTY id: that process holds nothing. The other terminal never did.
  spawned('pty-restored', undefined, false)
  const first = await rig.host.handOverToTerminal(SESSION)
  if (!first.ok) {
    throw new Error(`the idle chat was refused: ${first.reason}`)
  }
  expect(owner(rig)).toBeNull()
  // Before the terminal's PTY spawns, the hand-over holds the conversation.
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // The PTY spawns resuming it and its agent reports the Windows way. The PTY alone holds now.
  spawned('pty-1', THREAD, true)
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
  ).rejects.toThrow(REFUSED)
  expect(() =>
    assertLegacyAiVaultResumeAllowed({
      agent: 'claude',
      sessionId: THREAD,
      filePath: `/private-fixture/claude/projects/workspace/${THREAD}.jsonl`,
      codexHome: null,
      executionHostId: 'local'
    })
  ).toThrow(REFUSED)
  // The agent quits but its shell stays, and the pane's saved recipe goes: the PTY still runs.
  runtime.rows = [leftoverRow]
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // Orca restarts with the daemon alive, and each pane adopts its PTY: the same process holds
  // again. The shell that reused a hand-over's id, and the other terminal, still hold nothing.
  await restartOrca()
  await reattached('pty-1')
  await reattached('pty-restored')
  await reattached('pty-other')
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // The terminal closes. Its leftover row holds nothing; the chat writes again.
  runtime.ptys.set('pty-1', false)
  await rig.send('back in the chat').result
  await eventually(() => expect(owner(rig!)).not.toBeNull())
})
