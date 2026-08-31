import type { TerminalLiveness } from '../../shared/terminal'
import { terminalLivenessDescription, terminalLivenessLabels } from './terminal-liveness'

export function CanvasTerminalLiveness({ liveness }: { liveness: TerminalLiveness }): JSX.Element {
  return (
    <span className="node-status" data-liveness={liveness} title={terminalLivenessDescription(liveness)}>
      {terminalLivenessLabels[liveness].toUpperCase()}
    </span>
  )
}

export function SidebarTerminalLiveness({ liveness }: { liveness: TerminalLiveness }): JSX.Element {
  return (
    <span className="project-node-liveness" data-liveness={liveness}>
      {terminalLivenessLabels[liveness]}
    </span>
  )
}
