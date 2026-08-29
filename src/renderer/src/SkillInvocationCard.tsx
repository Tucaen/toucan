import type { JSX } from 'react'
import type { SkillInvocation } from './skill-invocation'
import { skillInvocationSummary } from './skill-invocation'

export function SkillInvocationSummary({ invocation }: { invocation: SkillInvocation }): JSX.Element {
  return (
    <span className="skill-summary">
      <span className="skill-name">{skillInvocationSummary(invocation)}</span>
      <span className="skill-badge">Skill</span>
    </span>
  )
}

export function SkillInvocationBody({ invocation, output }: {
  invocation: SkillInvocation
  output: string[]
}): JSX.Element {
  return (
    <div className="skill-body">
      {/* Why it was loaded, when the agent said so - the part that explains an unexpected skill. */}
      {invocation.reason && <small className="skill-reason">{invocation.reason}</small>}
      {output.length > 0 && <pre className="skill-output">{output.join('\n')}</pre>}
    </div>
  )
}
