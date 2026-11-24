import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
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
    // Direct close: the pin prompt belongs to the close commands, and the conversation moved on.
    useAppStore.getState().closeUnifiedTab(chatTab.id)
    return 'handled'
  } catch (error) {
    release()
    throw error
  }
}

function handoverRefusalMessage(
  reason: AiVaultChatTerminalHandoverRefusal,
  agent: AiVaultAgent
): string {
  switch (reason) {
    case 'turnActive':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.turnActive',
        '{{agent}} is still working. Continue in terminal when this turn ends.',
        { agent: agentLabel(agent) }
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
    case 'stopUnproven':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.stopUnproven',
        "Orca couldn't confirm the chat's agent stopped. Try again."
      )
    case 'busy':
      return translate(
        'auto.components.tab.bar.nativeChatTerminalHandover.busy',
        'This chat is busy. Continue in terminal when it is idle.'
      )
  }
}
