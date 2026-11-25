import { join } from 'node:path'
import { readNodeFileWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import { AtomicSnapshotWriter } from '../../persistence/atomic-snapshot-writer'
import {
  keysMayMatch,
  terminalConversationKey,
  type ConversationKey
} from './structured-conversation-key'

/** Long enough for a shell to start and the terminal's PTY to spawn and register on a slow machine. */
const SPAWN_GRACE_MS = 120_000
const HOLDS_FILENAME = 'terminal-conversation-holds.json'
const MAX_SAVED_PTY_HOLDS = 256
const MAX_HOLDS_FILE_BYTES = 64 * 1024

/** Whether the runtime's PTY still runs: undefined while it has no record of that PTY. */
export type TerminalPtyConnected = (ptyId: string) => boolean | undefined

type Hold =
  | { kind: 'handover'; key: ConversationKey; until: number }
  | { kind: 'pty'; key: ConversationKey; ptyId: string; until: number }

type SavedPtyHold = { ptyId: string; agent: string; conversationId: string }

/** PTYs held, forgotten or reattached while the saved holds still load. */
type LoadingHolds = { touched: Set<string>; reattached: Set<string> }

/** Which chat conversations a terminal may be writing, from facts Orca owns on every platform,
 *  hooks on or off: a hand-over until its terminal's PTY spawns, then each PTY Orca spawned as the
 *  hand-over's terminal (its launch carries the mark), while that PTY runs, reattached or not.
 *  Every process the terminal starts lives in its PTY, so a PTY that no longer runs writes
 *  nothing. Hook rows play no part. */
class TerminalConversationHolds {
  private readonly entries = new Map<string, Hold>()
  /** What each held PTY's process holds, kept across restarts so its reattach holds it again. Only
   *  a fresh process under the id clears it; the newest entries are kept. */
  private readonly saved = new Map<string, SavedPtyHold>()
  private writer: AtomicSnapshotWriter | null = null
  private loading: LoadingHolds | null = null
  private loaded: Promise<void> = Promise.resolve()
  private saving: Promise<void> = Promise.resolve()
  private nextId = 0

  /** At startup, before any pane reattaches; null keeps the saved holds in memory. */
  restore(userDataPath: string | null): Promise<void> {
    this.entries.clear()
    this.saved.clear()
    const file = userDataPath ? join(userDataPath, HOLDS_FILENAME) : null
    this.writer = file ? new AtomicSnapshotWriter(() => file, { fileMode: 0o600 }) : null
    const loading: LoadingHolds = { touched: new Set(), reattached: new Set() }
    this.loading = loading
    // An earlier run's last save lands first, as it does before a quit.
    this.loaded = this.saving.then(async () => {
      const holds = await readSavedPtyHolds(file)
      if (this.loading !== loading) {
        return
      }
      this.loading = null
      const newer = [...this.saved.values()]
      this.saved.clear()
      for (const hold of [
        ...holds.filter((saved) => !loading.touched.has(saved.ptyId)),
        ...newer
      ]) {
        this.saved.set(hold.ptyId, hold)
      }
      for (const ptyId of loading.reattached) {
        this.reholdPty(ptyId)
      }
    })
    return this.loaded
  }

  /** Resolves once a reattach that came before the saved holds loaded holds again. */
  ready(): Promise<void> {
    return this.loaded
  }

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
    this.loading?.touched.add(ptyId)
    const previous = this.saved.get(ptyId)
    if (previous?.agent !== agent || previous.conversationId !== conversationId) {
      this.saved.delete(ptyId)
      this.saved.set(ptyId, { ptyId, agent, conversationId })
      this.persist()
    }
  }

  /** A reattach: the same process again, after a reload or restart, holds what it held. */
  reholdPty(ptyId: string): void {
    this.loading?.reattached.add(ptyId)
    const saved = this.saved.get(ptyId)
    if (saved) {
      this.holdPty(saved.agent, saved.conversationId, ptyId)
    }
  }

  /** A new process under this PTY id holds nothing its predecessor held. */
  forgetPty(ptyId: string): void {
    for (const [id, hold] of this.entries) {
      if (hold.kind === 'pty' && hold.ptyId === ptyId) {
        this.entries.delete(id)
      }
    }
    this.loading?.touched.add(ptyId)
    this.loading?.reattached.delete(ptyId)
    if (this.saved.delete(ptyId)) {
      this.persist()
    }
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

  /** After the saved holds load, so a write never drops the ones not read yet. */
  private persist(): void {
    const writer = this.writer
    if (!writer) {
      return
    }
    this.saving = this.loaded
      .then(() => {
        const holds = [...this.saved.values()].slice(-MAX_SAVED_PTY_HOLDS)
        const json = JSON.stringify({ version: 1, holds })
        return writer.write(() => json)
      })
      .catch((error: unknown) =>
        // The holds still apply until this process exits.
        console.warn('[terminal-holds] Could not save the hand-over terminal holds:', error)
      )
  }
}

async function readSavedPtyHolds(file: string | null): Promise<SavedPtyHold[]> {
  if (!file) {
    return []
  }
  try {
    const { buffer } = await readNodeFileWithinLimit(file, MAX_HOLDS_FILE_BYTES)
    const parsed: unknown = JSON.parse(buffer.toString('utf8'))
    const holds =
      typeof parsed === 'object' && parsed !== null && 'holds' in parsed ? parsed.holds : null
    return Array.isArray(holds) ? holds.filter(isSavedPtyHold).slice(-MAX_SAVED_PTY_HOLDS) : []
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      console.warn('[terminal-holds] Could not read the hand-over terminal holds:', error)
    }
    return []
  }
}

function isSavedPtyHold(value: unknown): value is SavedPtyHold {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ptyId' in value &&
    typeof value.ptyId === 'string' &&
    value.ptyId.length > 0 &&
    'agent' in value &&
    typeof value.agent === 'string' &&
    'conversationId' in value &&
    typeof value.conversationId === 'string' &&
    value.conversationId.length > 0
  )
}

export const terminalConversationHolds = new TerminalConversationHolds()
