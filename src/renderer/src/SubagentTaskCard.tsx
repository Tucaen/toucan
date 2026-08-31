import { useContext } from 'react'
import type { JSX, ReactNode } from 'react'
import type { AgentActivity } from '../../shared/agent'
import {
  SubagentActivitiesContext,
  subagentProgress,
  subagentProgressLabel,
  subagentTaskSummary,
  type SubagentTask
} from './subagent-task'

/**
 * The delegation's header. The progress chip is the reason this card exists: it is read from the
 * subagent's own tool calls, so a delegation that has been running for four minutes says what it
 * is doing right now instead of only that it is running.
 */
export function SubagentTaskSummary({ task, activity }: { task: SubagentTask; activity: AgentActivity }): JSX.Element {
  const children = useContext(SubagentActivitiesContext).get(activity.id) ?? []
  const progress = subagentProgress(children)
  return (
    <span className="subagent-summary">
      {task.agentType && <span className="subagent-agent-type">{task.agentType}</span>}
      <span className="subagent-summary-label">{subagentTaskSummary(task, activity)}</span>
      {progress && <span className="subagent-progress">{subagentProgressLabel(progress)}</span>}
    </span>
  )
}

/**
 * The delegation's body: the instructions it was given, then the subagent's own steps as they
 * happen, then whatever it reported back. `renderStep` comes from the family registry rather than
 * being called here, so a step is drawn by its own tool card's summary without this component
 * having to reach back into the registry that owns it.
 */
export function SubagentTaskBody({
  task,
  activity,
  result,
  renderStep
}: {
  task: SubagentTask
  activity: AgentActivity
  result: string[]
  renderStep(step: AgentActivity): ReactNode
}): JSX.Element {
  const children = useContext(SubagentActivitiesContext).get(activity.id) ?? []
  return (
    <div className="subagent-body">
      {task.model && <small className="subagent-model">Model: {task.model}</small>}
      {task.prompt && <pre className="subagent-prompt">{task.prompt}</pre>}
      {children.length > 0 && <div className="subagent-steps">{children.map((step) => renderStep(step))}</div>}
      {children.length === 0 && activity.status === 'in_progress' && (
        <p className="subagent-waiting">Waiting for the subagent's first step…</p>
      )}
      {result.length > 0 && <pre className="subagent-result">{result.join('\n')}</pre>}
    </div>
  )
}
