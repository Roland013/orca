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
import { adoptMaterializedRuntimePtySpawn } from '../../../ipc/pty/runtime/spawn-early'
import { createRuntimePtySpawnState } from '../../../ipc/pty/runtime/spawn-state'
import { makeRuntimePtySpawnTestDeps } from '../../../ipc/pty/runtime/spawn-preflight-test-deps-fixture'
import { terminalConversationHolds } from '../../conversation-adoption/structured-terminal-conversation-holds'
import { terminalConversationKey } from '../../conversation-adoption/structured-conversation-key'
import { hookRowPaneResumeRecord } from '../../../runtime/session-lifecycle/projection/hook-row-pane-resume-record'
import { resolveResumeLaunchRecipe } from '../../../../shared/agent-launch/choices/resume-launch-recipe'
import { buildAgentResumeStartupPlan } from '../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
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

const PLAIN_LAUNCH: SleepingAgentLaunchConfig = { agentArgs: '', agentEnv: {} }

/** Each PTY's own pane, unless a step moves another PTY into it. */
const paneOf = (ptyId: string) => makePaneKey(`tab-${ptyId}`, LEAF)

/** A fresh Claude PTY as its spawn reports it. */
function spawned(
  ptyId: string,
  conversationId: string | undefined,
  launchConfig: SleepingAgentLaunchConfig | undefined,
  paneKey: string = paneOf(ptyId)
): void {
  runtime.ptys.set(ptyId, true)
  holdTerminalResumedConversation({
    agent: 'claude',
    launchConfig,
    providerSession: conversationId ? { key: 'session_id', id: conversationId } : undefined,
    ptyId,
    paneKey,
    connectionId: null
  })
}

/** The relaunch a cold restore builds once Claude had quit: the pane's record is the one its quit
 *  agent's retained row implies, as the window and main both derive it, so it has no recipe. */
function coldRestoredAfterQuitLaunch(): SleepingAgentLaunchConfig | undefined {
  const record = hookRowPaneResumeRecord({
    rows: [leftoverRow],
    worktreeId: 'workspace-1',
    tab: { id: 'terminal-tab' }
  })
  if (!record) {
    throw new Error('the quit agent left no resume record')
  }
  return buildAgentResumeStartupPlan({
    agent: 'claude',
    providerSession: record.providerSession,
    cmdOverrides: {},
    platform: process.platform,
    ...resolveResumeLaunchRecipe(record.launchConfig, 'claude', record.providerSession)
  })?.launchConfig
}

/** A pane's running PTY, as its stable-owner adoption answers it. */
function adoption(ptyId: string) {
  const owner = { handle: `handle-${ptyId}`, tabId: `tab-${ptyId}`, leafId: LEAF, ptyId }
  const result = { id: ptyId, isReattach: true }
  return {
    result,
    outcome: { kind: 'adopted' as const, result },
    owner,
    materialized: true as const
  }
}

/** A pane adopting its running PTY on a reload or a restart, through the runtime's spawn. */
async function reattached(ptyId: string): Promise<void> {
  runtime.ptys.set(ptyId, true)
  const adopted = adoption(ptyId)
  await spawnPtyFromRuntimeController(
    { ...makeRuntimePtySpawnTestDeps(), adoptStablePane: async () => adopted },
    { cols: 80, rows: 24, worktreeId: 'workspace-1', tabId: adopted.owner.tabId, leafId: LEAF }
  )
}

/** The runtime adopting a pane's running PTY for a CLI or phone `terminal.create`. */
async function adoptedByRuntime(ptyId: string): Promise<void> {
  runtime.ptys.set(ptyId, true)
  const adopted = adoption(ptyId)
  await adoptMaterializedRuntimePtySpawn(
    createRuntimePtySpawnState(makeRuntimePtySpawnTestDeps(), {
      cols: 80,
      rows: 24,
      worktreeId: 'workspace-1',
      tabId: adopted.owner.tabId,
      leafId: LEAF,
      adoptedStablePane: adopted
    })
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
  spawned('pty-restored', THREAD, handoverLaunch)
  spawned('pty-other', THREAD, PLAIN_LAUNCH)
  // The restored hand-over terminal holds the chat.
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // A fresh shell reuses its PTY id: that process holds nothing. The other terminal never did.
  spawned('pty-restored', undefined, PLAIN_LAUNCH)
  const first = await rig.host.handOverToTerminal(SESSION)
  if (!first.ok) {
    throw new Error(`the idle chat was refused: ${first.reason}`)
  }
  expect(owner(rig)).toBeNull()
  // Before the terminal's PTY spawns, the hand-over holds the conversation.
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // The PTY spawns resuming it and its agent reports the Windows way. The PTY alone holds now.
  spawned('pty-1', THREAD, handoverLaunch)
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
  // Again, and the runtime adopts the pane's PTY for a CLI or phone create instead.
  await restartOrca()
  await adoptedByRuntime('pty-1')
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // Orca restarts with the daemon stopped, so the PTYs are gone. The hand-over pane relaunches
  // Claude from its quit agent's row, unmarked, under the same PTY id; then its restart does,
  // under a new id. Each is the hand-over terminal restored, and holds.
  await restartOrca()
  spawned('pty-1', THREAD, coldRestoredAfterQuitLaunch())
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  runtime.ptys.set('pty-1', false)
  spawned('pty-1b', THREAD, coldRestoredAfterQuitLaunch(), paneOf('pty-1'))
  expect(await rig.host.handOverToTerminal(SESSION)).toEqual(IN_TERMINAL)
  // The terminal closes. Its leftover row holds nothing; the chat writes again.
  runtime.ptys.set('pty-1b', false)
  await rig.send('back in the chat').result
  await eventually(() => expect(owner(rig!)).not.toBeNull())
})

it('keeps the newest hand-over holds across a restart, however long their PTY ids', async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-terminal-holds-'))
  await terminalConversationHolds.restore(userDataPath)
  // Daemon ids carry the worktree path, so a fixed count of entries can outgrow the reader's limit.
  const ptyIdOf = (n: number) => `${'w'.repeat(480)}@@${n}`
  for (let n = 0; n < 300; n++) {
    spawned(ptyIdOf(n), `conversation-${n}`, handoverLaunch)
  }
  await restartOrca()
  await reattached(ptyIdOf(299))
  const newest = terminalConversationKey('claude', 'conversation-299')
  expect(terminalConversationHolds.holds(newest, (ptyId) => runtime.ptys.get(ptyId))).toBe(true)
})
