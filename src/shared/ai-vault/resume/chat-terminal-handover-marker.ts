import type { SleepingAgentLaunchConfig } from '../../agent-session/lifecycle/agent-session-resume'

/** Set in a hand-over terminal's launch env, and only there. The pane's saved launch config keeps it,
 *  so a restore or reattach of that terminal is still known as the hand-over's. */
export const CHAT_TERMINAL_HANDOVER_ENV = 'ORCA_CHAT_TERMINAL_HANDOVER'

export function isChatTerminalHandoverLaunch(
  launchConfig: Pick<SleepingAgentLaunchConfig, 'agentEnv'> | null | undefined
): boolean {
  return launchConfig?.agentEnv?.[CHAT_TERMINAL_HANDOVER_ENV] === '1'
}
