import { join } from 'node:path'
import { readNodeFileWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../../filesystem/durable-file-write'
import {
  keysMayMatch,
  terminalConversationKey,
  type ConversationKey
} from './structured-conversation-key'

/** Long enough for a shell to start and the terminal's PTY to spawn and register on a slow machine. */
const SPAWN_GRACE_MS = 120_000
const HOLDS_FILENAME = 'terminal-conversation-holds.json'
const MAX_SAVED_PTY_HOLDS = 256
/** The writer keeps the newest entries that fit, so the reader never refuses its own file. */
const MAX_HOLDS_FILE_BYTES = 64 * 1024
const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

/** Whether the runtime's PTY still runs: undefined while it has no record of that PTY. */
export type TerminalPtyConnected = (ptyId: string) => boolean | undefined

type Hold =
  | { kind: 'handover'; key: ConversationKey; until: number }
  | { kind: 'pty'; key: ConversationKey; ptyId: string; until: number }

type SavedPtyHold = { ptyId: string; paneKey?: string; agent: string; conversationId: string }

/** A fresh process in a PTY, as its spawn reports it. */
export type SpawnedTerminalPty = {
  ptyId: string
  paneKey: string | null
  /** The local conversation its launch resumes, for an agent whose chats hand over. */
  resumes: { agent: string; conversationId: string } | null
  /** Its launch carries the hand-over's mark. */
  marked: boolean
}

/** Which chat conversations a terminal may be writing, from facts Orca owns on every platform,
 *  hooks on or off: a hand-over until its terminal's PTY spawns, then each PTY Orca spawned as the
 *  hand-over's terminal, or as a restore of it, while that PTY runs, reattached or not. Every
 *  process the terminal starts lives in its PTY, so a PTY that no longer runs writes nothing. Hook
 *  rows play no part. */
class TerminalConversationHolds {
  private readonly entries = new Map<string, Hold>()
  /** What each held PTY's process holds, kept across restarts so its reattach and its pane's
   *  restore hold it again. Only a fresh process under the id or in the pane clears it. */
  private readonly saved = new Map<string, SavedPtyHold>()
  private file: string | null = null
  /** PTY changes reported while the saved holds load; they apply in order once loaded. */
  private pending: (() => void)[] | null = null
  private loaded: Promise<void> = Promise.resolve()
  private saving: Promise<void> = Promise.resolve()
  private saveGeneration = 0
  private nextId = 0

  /** At startup, before any pane reattaches; null keeps the saved holds in memory. */
  restore(userDataPath: string | null): Promise<void> {
    this.entries.clear()
    this.saved.clear()
    const file = userDataPath ? join(userDataPath, HOLDS_FILENAME) : null
    this.file = file
    const pending: (() => void)[] = []
    this.pending = pending
    if (file) {
      void removeStaleDurableWriteTempFiles(file, { minimumAgeMs: STALE_WRITE_TEMP_AGE_MS })
    }
    // An earlier run's last save lands first, as it does before a quit.
    this.loaded = this.saving.then(async () => {
      const holds = await readSavedPtyHolds(file)
      if (this.pending !== pending) {
        return
      }
      for (const hold of holds) {
        this.saved.set(hold.ptyId, hold)
      }
      this.pending = null
      for (const apply of pending) {
        apply()
      }
    })
    return this.loaded
  }

  /** Resolves once the saved holds loaded and the PTY changes reported meanwhile applied. */
  ready(): Promise<void> {
    return this.loaded
  }

  /** A hand-over about to start its terminal; that terminal's PTY spawn takes over the hold. */
  holdHandover(key: ConversationKey): string {
    return this.add({ kind: 'handover', key, until: Date.now() + SPAWN_GRACE_MS })
  }

  /** A fresh process holds nothing an earlier process under its id, or in its pane, held, unless
   *  its launch carries the hand-over's mark, or it resumes the very conversation that hand-over
   *  terminal held. A cold restore relaunches that from the pane's status rows, which never carry
   *  the mark. */
  spawnedPty(spawned: SpawnedTerminalPty): void {
    this.afterLoad(() => {
      const earlier = [...this.saved.values()].filter(
        (saved) =>
          saved.ptyId === spawned.ptyId ||
          (spawned.paneKey !== null && saved.paneKey === spawned.paneKey)
      )
      for (const saved of earlier) {
        this.forgetPty(saved.ptyId)
      }
      const resumes = spawned.resumes
      if (!resumes) {
        return
      }
      const key = terminalConversationKey(resumes.agent, resumes.conversationId)
      const restoresHandover = earlier.some((saved) =>
        keysMayMatch(terminalConversationKey(saved.agent, saved.conversationId), key)
      )
      if (spawned.marked || restoresHandover) {
        this.holdPty(resumes.agent, resumes.conversationId, spawned.ptyId, spawned.paneKey)
      }
    })
  }

  /** A reattach: the same process again, after a reload or restart, holds what it held. */
  reholdPty(ptyId: string): void {
    this.afterLoad(() => {
      const saved = this.saved.get(ptyId)
      if (saved) {
        this.holdPty(saved.agent, saved.conversationId, ptyId, saved.paneKey ?? null)
      }
    })
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

  /** A local PTY resuming `conversationId`; it takes over any hand-over waiting for it. */
  private holdPty(agent: string, conversationId: string, ptyId: string, paneKey: string | null) {
    const key = terminalConversationKey(agent, conversationId)
    for (const [id, hold] of this.entries) {
      if (hold.kind === 'handover' ? keysMayMatch(hold.key, key) : hold.ptyId === ptyId) {
        this.entries.delete(id)
      }
    }
    this.add({ kind: 'pty', key, ptyId, until: Date.now() + SPAWN_GRACE_MS })
    const previous = this.saved.get(ptyId)
    const savedPaneKey = paneKey ?? previous?.paneKey
    if (
      previous?.agent !== agent ||
      previous.conversationId !== conversationId ||
      previous.paneKey !== savedPaneKey
    ) {
      this.saved.delete(ptyId)
      this.saved.set(ptyId, {
        ptyId,
        ...(savedPaneKey ? { paneKey: savedPaneKey } : {}),
        agent,
        conversationId
      })
      this.persist()
    }
  }

  private forgetPty(ptyId: string): void {
    for (const [id, hold] of this.entries) {
      if (hold.kind === 'pty' && hold.ptyId === ptyId) {
        this.entries.delete(id)
      }
    }
    if (this.saved.delete(ptyId)) {
      this.persist()
    }
  }

  private afterLoad(apply: () => void): void {
    if (this.pending) {
      this.pending.push(apply)
    } else {
      apply()
    }
  }

  private add(hold: Hold): string {
    const id = `terminal-hold-${++this.nextId}`
    this.entries.set(id, hold)
    return id
  }

  /** Saves the holds as they are now; a save queued behind a newer one is skipped. */
  private persist(): void {
    const file = this.file
    if (!file) {
      return
    }
    const generation = ++this.saveGeneration
    const json = serializeSavedPtyHolds([...this.saved.values()])
    this.saving = this.saving
      .then(async () => {
        if (generation === this.saveGeneration) {
          await writeFileDurable(durableWriteTempPath(file), file, json, 0o600)
        }
      })
      .catch((error: unknown) =>
        // The holds still apply until this process exits.
        console.warn('[terminal-holds] Could not save the hand-over terminal holds:', error)
      )
  }
}

/** The newest entries that fit both the count cap and the reader's byte limit. */
function serializeSavedPtyHolds(holds: readonly SavedPtyHold[]): string {
  const kept: SavedPtyHold[] = []
  let bytes = Buffer.byteLength(JSON.stringify({ version: 1, holds: [] }))
  for (const hold of holds.toReversed()) {
    // One more byte for the separating comma.
    bytes += Buffer.byteLength(JSON.stringify(hold)) + 1
    if (kept.length >= MAX_SAVED_PTY_HOLDS || bytes > MAX_HOLDS_FILE_BYTES) {
      break
    }
    kept.unshift(hold)
  }
  return JSON.stringify({ version: 1, holds: kept })
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
    (!('paneKey' in value) || typeof value.paneKey === 'string') &&
    'agent' in value &&
    typeof value.agent === 'string' &&
    'conversationId' in value &&
    typeof value.conversationId === 'string' &&
    value.conversationId.length > 0
  )
}

export const terminalConversationHolds = new TerminalConversationHolds()
