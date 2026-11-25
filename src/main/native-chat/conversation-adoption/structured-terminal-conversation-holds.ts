import {
  keysMayMatch,
  terminalConversationKey,
  type ConversationKey
} from './structured-conversation-key'

/** Long enough for a shell to start and the terminal's PTY to spawn and register on a slow machine. */
const SPAWN_GRACE_MS = 120_000

/** Whether the runtime's PTY still runs: undefined while it has no record of that PTY. */
export type TerminalPtyConnected = (ptyId: string) => boolean | undefined

type Hold =
  | { kind: 'handover'; key: ConversationKey; until: number }
  | { kind: 'pty'; key: ConversationKey; ptyId: string; until: number }

/** Which chat conversations a terminal may be writing, from facts Orca owns on every platform,
 *  hooks on or off: a hand-over until its terminal's PTY spawns, then each PTY Orca spawned or
 *  reattached to resume the conversation, for as long as that PTY runs. Every process the terminal
 *  starts lives in its PTY, so a PTY that no longer runs writes nothing. Hook rows play no part. */
class TerminalConversationHolds {
  private readonly entries = new Map<string, Hold>()
  private nextId = 0

  /** A hand-over about to start its terminal; that terminal's PTY spawn takes over the hold. */
  holdHandover(key: ConversationKey): string {
    return this.add({ kind: 'handover', key, until: Date.now() + SPAWN_GRACE_MS })
  }

  /** A local PTY resuming `conversationId`; it takes over any hand-over waiting for it. */
  holdPty(agent: string, conversationId: string, ptyId: string): void {
    const key = terminalConversationKey(agent, conversationId)
    for (const [id, hold] of this.entries) {
      if (hold.kind === 'handover' ? keysMayMatch(hold.key, key) : hold.ptyId === ptyId) {
        this.entries.delete(id)
      }
    }
    this.add({ kind: 'pty', key, ptyId, until: Date.now() + SPAWN_GRACE_MS })
  }

  /** A hand-over whose terminal never spawned. A PTY's hold ends only with that PTY. */
  releaseHandover(id: string): void {
    if (this.entries.get(id)?.kind === 'handover') {
      this.entries.delete(id)
    }
  }

  holds(key: ConversationKey, connected: TerminalPtyConnected): boolean {
    const now = Date.now()
    let held = false
    for (const [id, hold] of this.entries) {
      const state = hold.kind === 'pty' ? connected(hold.ptyId) : undefined
      // A PTY the runtime hasn't recorded yet holds through the grace a spawn takes to register.
      if (state === false || (state === undefined && now >= hold.until)) {
        this.entries.delete(id)
      } else if (keysMayMatch(hold.key, key)) {
        held = true
      }
    }
    return held
  }

  private add(hold: Hold): string {
    const id = `terminal-hold-${++this.nextId}`
    this.entries.set(id, hold)
    return id
  }
}

export const terminalConversationHolds = new TerminalConversationHolds()
