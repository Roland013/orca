import { namesCliConversation } from '../../../shared/agent-session/view/structured-agent-cli-conversation-adoption'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { keysMayMatch, type ConversationKey } from './structured-conversation-key'

/** Long enough for a shell and the agent to start and report on a slow machine. */
export const TERMINAL_HANDOVER_FENCE_MS = 120_000

type HandoverFence = {
  agent: StructuredAgentId
  key: ConversationKey
  since: number
  until: number
}

type TerminalStatusRow = Parameters<typeof namesCliConversation>[0] & {
  structuredHost?: unknown
  receivedAt: number
}

/** A terminal given a chat's conversation writes it before its hooks report it, so the writer
 *  check can't see it yet: until a row it sent names the conversation, the chat must not start. */
export class StructuredTerminalHandoverFences {
  private readonly fences = new Map<string, HandoverFence>()
  private nextId = 0

  constructor(private readonly now: () => number = Date.now) {}

  hold(agent: StructuredAgentId, key: ConversationKey): string {
    const id = `terminal-handover-${++this.nextId}`
    const since = this.now()
    for (const [held, fence] of this.fences) {
      if (since >= fence.until) {
        this.fences.delete(held)
      }
    }
    this.fences.set(id, { agent, key, since, until: since + TERMINAL_HANDOVER_FENCE_MS })
    return id
  }

  release(id: string): void {
    this.fences.delete(id)
  }

  /** Whether a chat start on `key` must wait. A row received since the fence hands the guard to
   *  the writer check, which reads that row's process; an older row proves nothing. */
  holds(key: ConversationKey, rows: () => readonly TerminalStatusRow[]): boolean {
    const now = this.now()
    const listed = this.fences.size > 0 ? rows() : []
    let held = false
    for (const [id, fence] of this.fences) {
      if (
        now >= fence.until ||
        listed.some(
          (row) =>
            !row.structuredHost &&
            row.receivedAt >= fence.since &&
            fence.key.id !== null &&
            namesCliConversation(row, fence.agent, fence.key.id)
        )
      ) {
        this.fences.delete(id)
      } else if (keysMayMatch(fence.key, key)) {
        held = true
      }
    }
    return held
  }
}

export const terminalHandoverFences = new StructuredTerminalHandoverFences()
