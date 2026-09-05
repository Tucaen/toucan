import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { BRAIN_DUMP_OUTCOME_LABELS, type BrainDumpTopic } from '../../shared/brain-dump'
import type { WorkspaceProject } from '../../shared/terminal'
import { brainDumpTopicPreview, describeBrainDumpDate, resolveBrainDumpProject } from './brain-dump-topics'
import { BrainDumpProjectChip, brainDumpProjectDescription } from './BrainDumpProjectChip'

/**
 * The library's list column: an ARIA listbox whose rows carry enough identity to choose between
 * topics without opening them. Once the collection outgrows a screenful the list windows itself,
 * so a thousand topics cost the same DOM as fifty.
 */

/** Rows below this all render; above it, only the visible window plus a small overscan does. */
export const BRAIN_DUMP_WINDOW_THRESHOLD = 50
const ROW_HEIGHT = 92
const OVERSCAN = 6
/** Used until the list has been measured, so the first paint is never a single row. */
const ASSUMED_VIEWPORT_HEIGHT = 720

export interface BrainDumpTopicListProps {
  topics: readonly BrainDumpTopic[]
  projects: readonly WorkspaceProject[]
  today: string
  selectedSlug?: string
  labelledBy: string
  onSelect(slug: string): void
  /**
   * A row's project chip was clicked. Rows are listbox `option`s, so the chip is not a control of
   * its own - it selects the row and asks the reader's picker to open, which keeps the listbox
   * intact while still making the label the user is looking at act like the clickable tag it is.
   */
  onSelectProject?(slug: string): void
  listRef?: React.RefObject<HTMLDivElement>
}

export function brainDumpOptionId(slug: string): string {
  return `brain-dump-option-${slug}`
}

export default function BrainDumpTopicList(props: BrainDumpTopicListProps): JSX.Element {
  const { topics, selectedSlug } = props
  const fallbackRef = useRef<HTMLDivElement>(null)
  const scroller = props.listRef ?? fallbackRef
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(ASSUMED_VIEWPORT_HEIGHT)

  useEffect(() => {
    const height = scroller.current?.clientHeight
    if (height) setViewportHeight(height)
  }, [scroller, topics.length])

  const windowed = topics.length > BRAIN_DUMP_WINDOW_THRESHOLD
  const range = useMemo(() => {
    if (!windowed) return { start: 0, end: topics.length }
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const visible = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
    return { start: first, end: Math.min(topics.length, first + visible) }
  }, [scrollTop, topics.length, viewportHeight, windowed])

  const move = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const index = topics.findIndex((topic) => topic.slug === selectedSlug)
    const last = topics.length - 1
    if (last < 0) return
    let next: number | null = null
    if (event.key === 'ArrowDown') next = Math.min(last, index + 1)
    else if (event.key === 'ArrowUp') next = index <= 0 ? 0 : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    props.onSelect(topics[next].slug)
  }

  return (
    <div
      ref={scroller}
      className="brain-dump-list"
      role="listbox"
      aria-labelledby={props.labelledBy}
      aria-activedescendant={selectedSlug ? brainDumpOptionId(selectedSlug) : undefined}
      tabIndex={0}
      onKeyDown={move}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div
        className="brain-dump-list-runway"
        style={windowed ? { height: topics.length * ROW_HEIGHT, position: 'relative' } : undefined}
      >
        <div style={windowed ? { position: 'absolute', top: range.start * ROW_HEIGHT, left: 0, right: 0 } : undefined}>
          {topics.slice(range.start, range.end).map((topic) => {
            const project = resolveBrainDumpProject(topic.projectPath, props.projects)
            const selected = topic.slug === selectedSlug
            const describedBy = project.path ? `brain-dump-project-${topic.slug}` : undefined
            return (
              <div
                key={topic.slug}
                id={brainDumpOptionId(topic.slug)}
                role="option"
                aria-selected={selected}
                aria-describedby={describedBy}
                className="brain-dump-row"
                data-selected={selected ? 'true' : undefined}
                tabIndex={-1}
                onClick={() => props.onSelect(topic.slug)}
              >
                <span className="brain-dump-row-title">{topic.title}</span>
                <span className="brain-dump-row-preview">{brainDumpTopicPreview(topic.markdown)}</span>
                <span className="brain-dump-row-meta">
                  <span
                    className="brain-dump-row-project"
                    data-assignable={props.onSelectProject && topic.collection === 'active' ? 'true' : undefined}
                    onClick={(event) => {
                      if (!props.onSelectProject || topic.collection !== 'active') return
                      // The row still selects; only the reader's picker is asked to open as well.
                      event.stopPropagation()
                      props.onSelectProject(topic.slug)
                    }}
                  >
                    <BrainDumpProjectChip project={project} />
                  </span>
                  <span className="brain-dump-row-date">
                    Updated {describeBrainDumpDate(topic.updated, props.today)}
                  </span>
                  {topic.outcome && (
                    <span className="brain-dump-row-outcome">{BRAIN_DUMP_OUTCOME_LABELS[topic.outcome]}</span>
                  )}
                </span>
                {describedBy && (
                  <span id={describedBy} className="visually-hidden">
                    {brainDumpProjectDescription(project)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
