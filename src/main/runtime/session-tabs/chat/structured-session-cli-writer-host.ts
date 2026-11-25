import {
  terminalLaunchFacts,
  type TerminalLaunchResult
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import {
  assertChatConversationFreeOfTerminals,
  assertCliConversationWritersExited,
  type ChatConversationWriterHost
} from '../../agent-session/lifecycle/structured-agent-cli-writers'
import type { EnrichedAgentHookEventPayload } from '../../../agent-hooks/server/server-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentCliSourceRoute } from '../../../native-chat/conversation-adoption/structured-agent-cli-source'
import { OrcaRuntimeWithGetWorktreePs } from '../../workspaces/process-listing/workspace-process-listing'

export abstract class OrcaRuntimeWithStructuredSessionCliWriterHost extends OrcaRuntimeWithGetWorktreePs {
  getStructuredAgentCliSourceRoute(source: {
    workspaceId: string
    paneKey: string
  }): StructuredAgentCliSourceRoute {
    const pty = this.getPtyRecordForPaneKey(source.paneKey)
    if (!pty) {
      return 'unknown'
    }
    const pane = this.resolveTerminalPane(source.paneKey, source.workspaceId)
    if (pane.ptyId !== pty.ptyId || pty.worktreeId !== source.workspaceId) {
      return 'unknown'
    }
    return pty.connectionId ||
      pty.isWsl ||
      pty.wslDistro ||
      pane.executionHostId !== LOCAL_EXECUTION_HOST_ID
      ? 'unsupported'
      : 'native-local'
  }

  rememberSavedTerminalLaunchResult(ptyId: string, result: TerminalLaunchResult): void {
    const pty = this.ptysById.get(ptyId)
    if (pty && result.savedResumeDecision) {
      pty.savedTerminalLaunchResult = {
        incarnationId: pty.incarnationId,
        launchConfig: pty.launchConfig,
        launchToken: pty.launchToken,
        result: terminalLaunchFacts(result)
      }
    }
  }

  getTerminalLaunchResult(ptyId: string): TerminalLaunchResult | undefined {
    const pty = this.ptysById.get(ptyId)
    const saved = pty?.savedTerminalLaunchResult
    if (!pty) {
      return undefined
    }
    return terminalLaunchFacts({
      ...(saved?.incarnationId === pty.incarnationId &&
      saved.launchConfig === pty.launchConfig &&
      saved.launchToken === pty.launchToken
        ? saved.result
        : {}),
      launchAgent: pty.launchAgent ?? undefined,
      launchToken: pty.launchToken ?? undefined,
      launchConfig: pty.launchConfig ?? undefined
    })
  }

  /** A local hook that names its agent process supersedes the launch result saved for this PTY. */
  clearSavedTerminalLaunchOnAgentHook(event: EnrichedAgentHookEventPayload): void {
    const pty = this.getPtyRecordForPaneKey(event.paneKey)
    if (
      pty &&
      event.connectionId === null &&
      !event.structuredHost &&
      event.agentPresence?.process
    ) {
      delete pty.savedTerminalLaunchResult
    }
  }

  /** Before a chat start or a hand-over of the chat's conversation; see the guard. */
  protected assertStructuredChatAcquireAdmissible(record: AgentSessionRecord): Promise<void> {
    return assertChatConversationFreeOfTerminals(this.chatConversationWriters(), record)
  }

  async assertStructuredAdoptionTerminalWritersExited(
    agent: StructuredAgentId,
    providerSessionId: string,
    closingPaneKeys?: readonly string[]
  ): Promise<void> {
    await assertCliConversationWritersExited(
      this.chatConversationWriters(),
      agent,
      providerSessionId,
      closingPaneKeys
    )
  }

  private chatConversationWriters(): ChatConversationWriterHost {
    return {
      rows: () => this.getAgentProviderSessionRows(),
      observation: (row) => this.readHookCliWriterObservationFn?.(row) ?? null,
      ptyResolver: () => {
        // One identity read for every key, rather than a scan of all terminals per key.
        const context = this.createTerminalIdentityReadContext()
        return (paneKey) => this.getPtyRecordForPaneKey(paneKey, context)?.ptyId ?? null
      },
      ptyConnected: (ptyId) => this.ptysById.get(ptyId)?.connected
    }
  }
}
