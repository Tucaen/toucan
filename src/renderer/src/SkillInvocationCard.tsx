import { useContext } from 'react'
import type { JSX } from 'react'
import {
  SessionCommandsContext,
  skillDescription,
  skillInvocationSummary,
  type SkillInvocation
} from './skill-invocation'

export function SkillInvocationSummary({ invocation }: { invocation: SkillInvocation }): JSX.Element {
  return (
    <>
      <span className="skill-name">{skillInvocationSummary(invocation)}</span>
      <span className="skill-badge">Skill</span>
    </>
  )
}

export function SkillInvocationBody({
  invocation,
  output
}: {
  invocation: SkillInvocation
  output: string[]
}): JSX.Element {
  // What the skill says it is for - the nearest thing to "why it was loaded" anything reports.
  const description = skillDescription(invocation, useContext(SessionCommandsContext))
  return (
    <div className="skill-body">
      {description && <small className="skill-reason">{description}</small>}
      {output.length > 0 && <pre className="skill-output">{output.join('\n')}</pre>}
    </div>
  )
}
