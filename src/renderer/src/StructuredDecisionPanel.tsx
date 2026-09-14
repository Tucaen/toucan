/**
 * Provider-native question sets (ACP form elicitations, normalized in acp-session-manager.ts),
 * rendered one question at a time with retained tabbed answers before returning one typed
 * response. The form rules - what counts as answered, when submission is gated, where a tab key
 * lands, and how a chosen option and its "Other" text exclude each other - are the pure
 * `decision-form.ts`; this file is the markup and focus wiring. While a request is pending the
 * ordinary composer is hidden (see ChatView), so free text cannot bypass the response channel.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, ListChecks } from 'lucide-react'
import type { AgentDecisionRequest, AgentDecisionResponseContent } from '../../shared/agent'
import {
  allRequiredAnswered,
  decisionAnswered,
  decisionTabTarget,
  requiredAnswersRemaining,
  withChosenOption,
  withCustomAnswer,
  withNumberAnswer
} from './decision-form'

export interface StructuredDecisionPanelProps {
  decisionRequest?: AgentDecisionRequest | null
  resolveElicitation?(requestId: string, content?: AgentDecisionResponseContent): void
}

export default function StructuredDecisionPanel(props: StructuredDecisionPanelProps): JSX.Element | null {
  const request = props.decisionRequest
  const [active, setActive] = useState(0)
  const [answers, setAnswers] = useState<AgentDecisionResponseContent>({})
  const [resolving, setResolving] = useState(false)
  const resolutionStarted = useRef(false)
  const headingId = useId()
  const questionTabs = useRef<Array<HTMLButtonElement | null>>([])
  const pendingQuestionFocus = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingQuestionFocus.current !== active) return
    questionTabs.current[active]?.focus()
    pendingQuestionFocus.current = null
  }, [active])
  if (!request || !props.resolveElicitation) return null
  const question = request.questions[active]
  if (!question) return null
  const currentAnswer = answers[question.id]
  const requiredComplete = allRequiredAnswered(request.questions, answers)
  const requiredRemaining = requiredAnswersRemaining(request.questions, answers)
  const questionLabel = (item: AgentDecisionRequest['questions'][number], index: number): string =>
    `Question ${index + 1}: ${item.title ?? item.question}${decisionAnswered(item, answers) ? ', answered' : ''}`
  const activateTab = (index: number, tabList: HTMLElement): void => {
    setActive(index)
    const tabs = tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs[index]?.focus()
  }
  const advanceTo = (index: number): void => {
    pendingQuestionFocus.current = index
    setActive(index)
  }
  const resolveOnce = (content?: AgentDecisionResponseContent): void => {
    if (resolutionStarted.current) return
    resolutionStarted.current = true
    setResolving(true)
    props.resolveElicitation!(request.id, content)
  }
  const choose = (value: string): void => {
    setAnswers((current) => withChosenOption(question, current, value))
    if (!question.multiSelect && active < request.questions.length - 1) advanceTo(active + 1)
  }
  return (
    <section
      className="structured-decision nodrag nopan nowheel"
      aria-labelledby={headingId}
      aria-describedby={`${headingId}-context`}
    >
      <header className="structured-decision-header">
        <div className="structured-decision-heading">
          <span className="structured-decision-icon" aria-hidden="true">
            <ListChecks />
          </span>
          <div>
            <strong id={headingId}>Decision questions</strong>
            <p id={`${headingId}-context`}>{request.message}</p>
          </div>
        </div>
        <span className="structured-decision-count">
          {request.questions.filter((item) => decisionAnswered(item, answers)).length}/{request.questions.length}{' '}
          answered
        </span>
      </header>
      {request.questions.length > 1 && (
        <div className="structured-decision-tabs" role="tablist" aria-label="Questions">
          {request.questions.map((item, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-label={questionLabel(item, index)}
              aria-controls={`${headingId}-panel`}
              id={`${headingId}-tab-${index}`}
              ref={(element) => {
                questionTabs.current[index] = element
              }}
              tabIndex={index === active ? 0 : -1}
              data-answered={decisionAnswered(item, answers)}
              key={item.id}
              onClick={() => setActive(index)}
              onKeyDown={(event) => {
                const next = decisionTabTarget(event.key, index, request.questions.length)
                if (next === null) return
                event.preventDefault()
                activateTab(next, event.currentTarget.parentElement!)
              }}
            >
              <span>{decisionAnswered(item, answers) ? <Check aria-hidden="true" /> : index + 1}</span>
              <small>{item.title ?? `Question ${index + 1}`}</small>
            </button>
          ))}
        </div>
      )}
      <article
        className="structured-decision-question"
        id={`${headingId}-panel`}
        data-scroll-region="question"
        role={request.questions.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={request.questions.length > 1 ? `${headingId}-tab-${active}` : `${headingId}-question`}
      >
        <div className="structured-decision-progress">
          <span>
            Question {active + 1} of {request.questions.length}
          </span>
          {question.required && <span className="structured-decision-required">Required</span>}
        </div>
        {question.title && <strong>{question.title}</strong>}
        <p id={`${headingId}-question`}>{question.question}</p>
        {question.input === 'select' && (
          <div className="structured-decision-options" role="group" aria-labelledby={`${headingId}-question`}>
            {question.options.map((option) => {
              const value = answers[question.id]
              const selected = Array.isArray(value) ? value.includes(option.value) : value === option.value
              return (
                <button type="button" aria-pressed={selected} key={option.value} onClick={() => choose(option.value)}>
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </button>
              )
            })}
          </div>
        )}
        {question.input === 'boolean' && (
          <div className="structured-decision-options" role="group" aria-labelledby={`${headingId}-question`}>
            {(['Yes', 'No'] as const).map((label) => {
              const value = label === 'Yes'
              return (
                <button
                  type="button"
                  aria-pressed={answers[question.id] === value}
                  key={label}
                  onClick={() => {
                    setAnswers((current) => ({ ...current, [question.id]: value }))
                    if (active < request.questions.length - 1) advanceTo(active + 1)
                  }}
                >
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
        )}
        {question.input === 'text' && (
          <input
            className="structured-decision-value"
            type="text"
            aria-label={question.question}
            value={typeof currentAnswer === 'string' ? currentAnswer : ''}
            onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
          />
        )}
        {question.input === 'number' && (
          <input
            className="structured-decision-value"
            type="number"
            aria-label={question.question}
            value={typeof currentAnswer === 'number' ? currentAnswer : ''}
            onChange={(event) => setAnswers((current) => withNumberAnswer(question, current, event.target.value))}
          />
        )}
        {question.customAnswerId && (
          <label className="structured-decision-other">
            <span>Other answer</span>
            <input
              type="text"
              value={
                typeof answers[question.customAnswerId] === 'string' ? (answers[question.customAnswerId] as string) : ''
              }
              onChange={(event) => setAnswers((current) => withCustomAnswer(question, current, event.target.value))}
            />
          </label>
        )}
      </article>
      <footer>
        <span role="status" aria-live="polite">
          {requiredRemaining === 0
            ? 'Ready to submit'
            : `${requiredRemaining} required answer${requiredRemaining === 1 ? '' : 's'} remaining`}
        </span>
        <button className="structured-decision-skip" type="button" disabled={resolving} onClick={() => resolveOnce()}>
          Skip
        </button>
        {active === request.questions.length - 1 && (
          <button type="button" disabled={!requiredComplete || resolving} onClick={() => resolveOnce(answers)}>
            Submit answers
          </button>
        )}
      </footer>
    </section>
  )
}
