import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { TerminalPaneLayoutNode } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { translate } from '@/i18n/i18n'
import { AiVaultChatForkSourceSchema } from '../../../../../shared/ai-vault/contracts/ai-vault-chat-fork-contract'
import type { AiVaultAgent } from '../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultChatTerminalHandoverRefusal } from '../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import type { AiVaultResumeLaunchSettings } from '../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import { agentLabel } from '../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { NativeChatCliForkSubject } from '@/lib/agent-session/resume/cli-fork/native-chat-cli-fork-preparation'
import { buildAiVaultCliForkStartupForWorktree } from '@/lib/agent-session/resume/history/ai-vault-session-fork-startup'
import { launchAiVaultSessionAndReveal } from '@/lib/agent-session/resume/history/launch-ai-vault-session-and-reveal'
import { describeAiVaultCliForkFailure } from '../../right-sidebar/ai-vault/session-actions/ai-vault-session-cli-fork'

/** "Continue in terminal" in place, for a chat on this desktop: its stopped agent's conversation
 *  resumes in a terminal that takes the chat's slot and name, and the chat tab closes.
 *  `unsupported` changed nothing, so the caller forks as before. */
export async function runNativeChatTerminalHandover(args: {
  subject: NativeChatCliForkSubject
  tab: { id: string; worktreeId: string }
  agent: AiVaultAgent
  settings: AiVaultResumeLaunchSettings | null | undefined
  isCurrent: () => boolean
  /** Runs right before the terminal opens, whose launch must not be cancelled by the chat closing. */
  beforeLaunch: () => void
}): Promise<'unsupported' | 'handled'> {
  const { subject, tab } = args
  const result = await window.api.aiVault.prepareChatTerminalHandover({
    sourceChat: { sessionId: subject.sessionId, workspaceId: subject.workspaceId }
  })
  if (result.kind === 'unsupported') {
    return 'unsupported'
  }
  if (result.kind === 'refused') {
    toast.error(handoverRefusalMessage(result.reason, args.agent))
    return 'handled'
  }
  // A terminal that never opened must not keep the chat from starting until the fence lapses.
  const release = () =>
    void window.api.aiVault.releaseChatTerminalHandover(result.handoverId).catch(() => undefined)
  try {
    const chatTab = useAppStore
      .getState()
      .unifiedTabsByWorktree[tab.worktreeId]?.find((item) => item.id === tab.id)
    if (!chatTab || !args.isCurrent()) {
      release()
      return 'handled'
    }
    const startup = buildAiVaultCliForkStartupForWorktree({
      state: useAppStore.getState(),
      worktreeId: subject.workspaceId,
      session: {
        ...AiVaultChatForkSourceSchema.parse(result.source),
        executionHostId: LOCAL_EXECUTION_HOST_ID
      },
      copied: false,
      sameConversation: true,
      owner: null,
      settings: args.settings
    })
    if (!startup) {
      throw new Error(
        translate(
          'auto.components.tab.bar.nativeChatCliFork.cannotOpenInCli',
          'This session cannot be opened in the CLI.'
        )
      )
    }
    args.beforeLaunch()
    const terminalTabId = await launchAiVaultSessionAndReveal(
      {
        agent: result.source.agent,
        worktreeId: subject.workspaceId,
        ...startup,
        targetGroupId: chatTab.groupId,
        afterTabId: chatTab.id,
        title: chatTab.customLabel?.trim() || result.conversationName || chatTab.label
      },
      describeAiVaultCliForkFailure
    )
    if (!terminalTabId) {
      release()
      return 'handled'
    }
    releaseIfEndedUnreported(subject.workspaceId, terminalTabId, result.source.sessionId, release)
    // Direct close: the pin prompt belongs to the close commands, and the conversation moved on.
    useAppStore.getState().closeUnifiedTab(chatTab.id)
    return 'handled'
  } catch (error) {
    release()
    throw error
  }
}

/** The pane a new tab launched in; a split keeps it on the `first` side. */
export function launchedLeafId(
  node: TerminalPaneLayoutNode | null | undefined
): string | undefined {
  return !node ? undefined : node.type === 'leaf' ? node.leafId : launchedLeafId(node.first)
}

/** Until the terminal's agent reports the conversation, the host holds it. A terminal closed or
 *  ended before that report would otherwise hold it until the fence lapses. */
function releaseIfEndedUnreported(
  worktreeId: string,
  tabId: string,
  conversationId: string,
  release: () => void
): void {
  let spawned = false
  const settled = (state: AppState): boolean => {
    const tab = state.tabsByWorktree[worktreeId]?.find((item) => item.id === tabId)
    spawned ||= Boolean(tab?.ptyId)
    const leafId = launchedLeafId(state.terminalLayoutsByTabId[tabId]?.root)
    const reported = leafId
      ? state.agentStatusByPaneKey.get(`${tabId}:${leafId}`)?.providerSession?.id === conversationId
      : false
    if (!reported && (!tab || (spawned && !tab.ptyId))) {
      release()
      return true
    }
    return reported
  }
  if (settled(useAppStore.getState())) {
    return
  }
  const stop = useAppStore.subscribe((state) => {
    if (settled(state)) {
      stop()
    }
  })
}

function handoverRefusalMessage(
  reason: AiVaultChatTerminalHandoverRefusal,
  agent: AiVaultAgent
): string {
  const options = { agent: agentLabel(agent) }
  switch (reason) {
    case 'turnActive':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.turnActive',
        '{{agent}} is still working. Continue in terminal when this turn ends.',
        options
      )
    case 'promptPending':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.promptPending',
        'Answer the pending question or approval first.'
      )
    case 'backgroundTasksRunning':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.backgroundTasksRunning',
        'Wait for background tasks to finish, or stop them, first.'
      )
    case 'messagesUnsettled':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.messagesUnsettled',
        'Wait for queued or unsent messages to be delivered first.'
      )
    case 'rewindUnconfirmed':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.rewindUnconfirmed',
        'Send a message after rewinding this chat, then continue in terminal.'
      )
    case 'handoffInFlight':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.handoffInFlight',
        'This chat is being handed off. Continue in terminal when that finishes.'
      )
    case 'clearInFlight':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.clearInFlight',
        'Wait for /clear to finish, then continue in terminal.'
      )
    case 'agentStarting':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.agentStarting',
        '{{agent}} is still starting. Continue in terminal once it is ready.',
        options
      )
    case 'agentBusy':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.agentBusy',
        '{{agent}} reported unfinished work. Continue in terminal when it is idle.',
        options
      )
    case 'openInTerminal':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.openInTerminal',
        'This conversation is already open in a terminal. Close that terminal first.'
      )
    case 'stopUnproven':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.stopUnproven',
        "Orca couldn't confirm the chat's agent stopped. Send a message in the chat, then continue in terminal once it is idle."
      )
  }
}
