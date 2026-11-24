import { expect, it } from 'vitest'
import type { AgentSessionOwnerObservation } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
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

// The chat-to-terminal handover admits its terminal through this rule: one writer per conversation.
it('lets a terminal resume a Claude chat conversation only once its owner is proven exited', () => {
  expect(terminalResumeBlocked(holding('claude', LIVE))).toBe(true)
  expect(terminalResumeBlocked(holding('claude', UNPROVEN))).toBe(true)
  expect(terminalResumeBlocked(holding('claude', RELEASED))).toBe(false)
  // An earlier link is no longer the conversation the chat writes.
  expect(terminalResumeBlocked(holding('claude', LIVE, 'earlier'))).toBe(false)
  // Other agents' chats keep refusing same-id terminal resumes.
  expect(terminalResumeBlocked(holding('codex', RELEASED))).toBe(true)
})
