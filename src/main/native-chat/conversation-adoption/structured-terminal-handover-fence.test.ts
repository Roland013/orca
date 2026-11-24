import { expect, it } from 'vitest'
import {
  StructuredTerminalHandoverFences,
  TERMINAL_HANDOVER_FENCE_MS
} from './structured-terminal-handover-fence'

const CONVERSATION = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
const KEY = { family: 'claude', id: CONVERSATION, home: null }

function terminalRow(receivedAt: number, id = CONVERSATION) {
  return {
    paneKey: 'terminal-tab:leaf',
    connectionId: null,
    agentType: 'claude',
    providerSession: { id },
    receivedAt
  }
}

// Never two writers: between the chat's stop and the terminal's first hook report, the writer
// check sees no terminal, so the fence alone keeps the chat from starting.
it('holds a chat start until a terminal reports the conversation after the handover', () => {
  let now = 1_000
  const fences = new StructuredTerminalHandoverFences(() => now)
  fences.hold('claude', KEY)
  // A row from before the handover (an older terminal) proves nothing about the new one.
  expect(fences.holds(KEY, () => [terminalRow(999)])).toBe(true)
  // Another conversation is not held.
  expect(fences.holds({ ...KEY, id: 'other' }, () => [])).toBe(false)
  now = 1_500
  expect(fences.holds(KEY, () => [terminalRow(1_400, 'other')])).toBe(true)
  // Once the terminal reports, the writer check reads its process instead.
  expect(fences.holds(KEY, () => [terminalRow(1_400)])).toBe(false)
  expect(fences.holds(KEY, () => [])).toBe(false)
})

it('lets the chat start once the fence lapses or its terminal never opened', () => {
  let now = 1_000
  const fences = new StructuredTerminalHandoverFences(() => now)
  fences.hold('claude', KEY)
  now += TERMINAL_HANDOVER_FENCE_MS - 1
  expect(fences.holds(KEY, () => [])).toBe(true)
  now += 1
  expect(fences.holds(KEY, () => [])).toBe(false)

  fences.release(fences.hold('claude', KEY))
  expect(fences.holds(KEY, () => [])).toBe(false)
})
