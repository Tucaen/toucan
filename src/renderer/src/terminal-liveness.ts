import type { TerminalLiveness } from '../../shared/terminal'

export const terminalLivenessLabels: Record<TerminalLiveness, string> = {
  live: 'Live',
  unverifiable: 'Unverifiable',
  exited: 'Exited'
}

export function terminalLivenessDescription(liveness: TerminalLiveness): string {
  if (liveness === 'live') return 'The process owner reports this terminal is live.'
  if (liveness === 'exited') return 'The process owner confirmed this terminal exited.'
  return 'Toucan cannot currently verify whether this terminal process is still running.'
}
