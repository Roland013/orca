import { namesCliConversation } from '../../../shared/agent-session/view/structured-agent-cli-conversation-adoption'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { keysMayMatch, type ConversationKey } from './structured-conversation-key'

/** Long enough for a shell and the agent to start and report on a slow machine. */
const TERMINAL_HANDOVER_FENCE_MS = 120_000

/** `handover`: a chat gave its conversation to a terminal. `resume`: a same-id terminal resume
 *  was admitted; a later check of that same resume must not be refused by its own fence. */
type FenceKind = 'handover' | 'resume'

type HandoverFence = {
  agent: StructuredAgentId
  key: ConversationKey
  kind: FenceKind
  since: number
  until: number
}

type TerminalStatusRow = Parameters<typeof namesCliConversation>[0] & {
  structuredHost?: unknown
  providerSessionOnly?: boolean
  receivedAt: number
}

/** A terminal given a chat's conversation writes it before Orca sees it there, so the writer
 *  checks can't find it yet: until a row it sent names the conversation, nothing else may write. */
class StructuredTerminalHandoverFences {
  private readonly fences = new Map<string, HandoverFence>()
  private nextId = 0

  hold(agent: StructuredAgentId, key: ConversationKey, kind: FenceKind): string {
    const id = `terminal-handover-${++this.nextId}`
    const since = Date.now()
    for (const [held, fence] of this.fences) {
      if (since >= fence.until) {
        this.fences.delete(held)
      }
    }
    this.fences.set(id, { agent, key, kind, since, until: since + TERMINAL_HANDOVER_FENCE_MS })
    return id
  }

  release(id: string): void {
    this.fences.delete(id)
  }

  /** Whether `key` is held. The agent's own report since the fence hands the guard to the
   *  writer check; an older row proves nothing, and a spawn's resume row only names the pane. */
  holds(key: ConversationKey, rows: () => readonly TerminalStatusRow[], kinds: FenceKind[]) {
    const now = Date.now()
    const listed = this.fences.size > 0 ? rows() : []
    let held = false
    for (const [id, fence] of this.fences) {
      if (
        now >= fence.until ||
        listed.some(
          (row) =>
            !row.structuredHost &&
            row.providerSessionOnly !== true &&
            row.receivedAt >= fence.since &&
            fence.key.id !== null &&
            namesCliConversation(row, fence.agent, fence.key.id)
        )
      ) {
        this.fences.delete(id)
      } else if (kinds.includes(fence.kind) && keysMayMatch(fence.key, key)) {
        held = true
      }
    }
    return held
  }
}

export const terminalHandoverFences = new StructuredTerminalHandoverFences()
