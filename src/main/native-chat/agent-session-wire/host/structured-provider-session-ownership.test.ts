import { expect, it } from 'vitest'
import type { AgentSessionOwnerObservation } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  handoverTerminalResumeBlocked,
  terminalResumeBlocked,
  type StructuredProviderSessionOwnership
} from './structured-provider-session-ownership'

const RELEASED: AgentSessionOwnerObservation = {
  claimStatus: 'released',
  handoffStage: null,
  handoffOperationId: null,
  ownerProcess: null,
  reservedSpawnToken: null,
  provenHandleLinkId: null,
  leaseDeadlineAt: 0,
  lastRenewedAt: 0,
  unreconciled: false,
  deathEvidence: { kind: 'exit-observed', detail: 'exit 0', observedAt: 1 }
}
const LIVE: AgentSessionOwnerObservation = {
  ...RELEASED,
  claimStatus: 'live',
  ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-a' },
  deathEvidence: null
}
// Released without proof the owner is gone, e.g. after a crash.
const UNPROVEN: AgentSessionOwnerObservation = { ...RELEASED, deathEvidence: null }

function holding(
  provider: StructuredProviderSessionOwnership['provider'],
  ownerObservation: AgentSessionOwnerObservation,
  role: StructuredProviderSessionOwnership['role'] = 'head'
): StructuredProviderSessionOwnership {
  return {
    wslDistro: null,
    sessionId: 'chat-1',
    workspaceId: 'workspace-1',
    provider,
    providerSessionId: '819cf9f8-e43c-4ad7-b50f-54aa158a726a',
    ownerObservation,
    role,
    key: { family: provider, id: '819cf9f8-e43c-4ad7-b50f-54aa158a726a', home: null }
  }
}

// One writer per conversation: a terminal gets a chat's conversation only through Orca's own
// hand-over, and only once the chat's agent is proven gone.
it('lets a terminal take a Claude chat conversation only by hand-over, after a proven exit', () => {
  expect(handoverTerminalResumeBlocked(holding('claude', LIVE))).toBe(true)
  expect(handoverTerminalResumeBlocked(holding('claude', UNPROVEN))).toBe(true)
  expect(handoverTerminalResumeBlocked(holding('claude', RELEASED))).toBe(false)
  // An earlier link is no longer the conversation the chat writes.
  expect(handoverTerminalResumeBlocked(holding('claude', LIVE, 'earlier'))).toBe(false)
  // Other agents' chats never hand over.
  expect(handoverTerminalResumeBlocked(holding('codex', RELEASED))).toBe(true)
  // A sent or History resume stays refused even after a proven exit.
  expect(terminalResumeBlocked(holding('claude', RELEASED))).toBe(true)
})
