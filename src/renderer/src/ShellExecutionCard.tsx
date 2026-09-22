import { createContext, useContext } from 'react'
import type { JSX } from 'react'
import type { AgentActivity } from '../../shared/agent'
import {
  clampShellOutputBlocks,
  shellCommandLine,
  shellExecutionFor,
  shellExitLabel,
  shellExitTone,
  shellOutputBlocks,
  shellWorkingDirectoryLabel,
  type ShellExecution,
  type ShellLaunch,
  type ShellOutputBlock
} from './shell-execution'
import { WorkspaceRootsContext } from './workspace-root'

/**
 * Which command started which background shell, for the whole worklog (`indexShellLaunches`).
 * A `BashOutput`/`KillShell` card needs an answer that no single activity holds, and it sits deep
 * inside the shell's rendering, so it travels as context rather than through every card signature.
 */
export const ShellLaunchesContext = createContext<ReadonlyMap<string, ShellLaunch>>(new Map())

const FOLLOW_UP_VERB: Record<'output' | 'kill', string> = {
  output: 'Read output of',
  kill: 'Killed'
}

/** What a follow-up card leads with: the command it is about, or failing that the shell's id. */
function useFollowUpLabel(execution: ShellExecution): { verb: string; subject: string } {
  const launches = useContext(ShellLaunchesContext)
  const verb = FOLLOW_UP_VERB[execution.kind === 'kill' ? 'kill' : 'output']
  const launch = execution.shellId ? launches.get(execution.shellId) : undefined
  if (launch) return { verb, subject: shellCommandLine(launch.command) }
  return { verb, subject: execution.shellId ? `shell ${execution.shellId}` : 'a background shell' }
}

/**
 * The header line: the command itself, on one line, so a rail of cards is scannable by command
 * alone. The exit chip and the working directory sit beside it and never take room from it - a
 * truncated command is still recognizable, a truncated exit code is not.
 */
export function ShellExecutionSummary({
  execution,
  status
}: {
  execution: ShellExecution
  status: AgentActivity['status']
}): JSX.Element {
  const roots = useContext(WorkspaceRootsContext)
  const followUp = useFollowUpLabel(execution)
  const exit = shellExitLabel(execution)
  const tone = shellExitTone(execution, status)
  const cwd = shellWorkingDirectoryLabel(execution.cwd, roots)
  return (
    <>
      {execution.kind === 'run' ? (
        <code className="shell-summary-command" title={execution.command}>
          {shellCommandLine(execution.command ?? '')}
        </code>
      ) : (
        <span className="shell-summary-command">
          <span className="shell-summary-verb">{followUp.verb}</span> <code>{followUp.subject}</code>
        </span>
      )}
      {cwd && (
        <span className="shell-summary-cwd" title={execution.cwd}>
          in {cwd}
        </span>
      )}
      {execution.background && <span className="shell-summary-flag">bg</span>}
      {exit && (
        <span className="shell-summary-exit" data-tone={tone}>
          {exit}
        </span>
      )}
    </>
  )
}

const STREAM_LABELS: Record<ShellOutputBlock['stream'], string | undefined> = {
  stdout: 'stdout',
  stderr: 'stderr',
  output: undefined
}

function ShellOutputBlockView({ block }: { block: ShellOutputBlock }): JSX.Element {
  const label = STREAM_LABELS[block.stream]
  return (
    <div className="shell-block" data-stream={block.stream}>
      {label && <small className="tool-block-label">{label}</small>}
      <pre className="shell-lines">{block.lines.join('\n')}</pre>
    </div>
  )
}

export function ShellExecutionBody({
  execution,
  blocks
}: {
  execution: ShellExecution
  blocks: ShellOutputBlock[]
}): JSX.Element {
  const roots = useContext(WorkspaceRootsContext)
  const cwd = shellWorkingDirectoryLabel(execution.cwd, roots)
  return (
    <div className="shell-exec">
      {execution.kind === 'run' && execution.command && (
        <div className="shell-command">
          <code title={execution.command}>{execution.command}</code>
          <button
            type="button"
            className="tool-inline-button"
            onClick={() => window.terminalApi?.copyText(execution.command ?? '')}
          >
            Copy
          </button>
        </div>
      )}
      {execution.description && <small className="shell-description">{execution.description}</small>}
      {cwd && <small className="shell-cwd">Working directory: {cwd}</small>}
      {execution.shellId && <small className="shell-id">Background shell {execution.shellId}</small>}
      {blocks.map((block) => (
        <ShellOutputBlockView block={block} key={block.stream} />
      ))}
    </div>
  )
}

/**
 * Everything a shell card's body renders, computed once so the shell's family hooks stay thin.
 * Returns `null` for an activity that is not a recognizable shell call.
 */
export function shellExecutionCard(
  activity: AgentActivity,
  lineBudget: number | null
): { execution: ShellExecution; blocks: ShellOutputBlock[]; hiddenLines: number } | null {
  const execution = shellExecutionFor(activity)
  if (!execution) return null
  const clamped = clampShellOutputBlocks(shellOutputBlocks(activity), lineBudget)
  return { execution, blocks: clamped.blocks, hiddenLines: clamped.hiddenLines }
}
