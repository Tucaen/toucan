import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { findMatchRanges, matchCountLabel, stepMatchIndex } from './node-search'
import {
  clearFindHighlights,
  collectSearchableText,
  rangeForMatch,
  scrollMatchIntoView,
  setFindHighlights
} from './node-search-dom'

export interface FindBarProps {
  /** The rendered element whose text is searched. */
  containerRef: React.RefObject<HTMLElement | null>
  /**
   * Changes whenever the searched text changes, so a document an agent is still writing keeps its
   * match list honest. Ranges point into live DOM nodes that a re-render replaces.
   */
  contentKey: string
  /** Bumped each time the node is asked to search again, which re-focuses and selects the query. */
  openSignal: number
  /** Names the surface being searched, for screen readers. */
  label: string
  onClose: () => void
}

const stopDrag = (event: React.MouseEvent): void => event.stopPropagation()

/**
 * The find bar for surfaces that render their text as plain DOM: the file node's rendered Markdown
 * today, AI-chat and diff nodes next. It owns the query, the match run and which match is current;
 * the counting is pure (`node-search.ts`) and the DOM work - flattening, ranges, scrolling and
 * highlighting - is `node-search-dom.ts`. CodeMirror is not one of these surfaces: it virtualizes
 * its viewport, so only a fraction of the document is in the DOM at any time and `@codemirror/search`
 * is what searches it.
 */
export default function FindBar({ containerRef, contentKey, openSignal, label, onClose }: FindBarProps): JSX.Element {
  const owner = useId()
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [index, setIndex] = useState(-1)
  const searchedQuery = useRef<string | null>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [openSignal])

  useEffect(() => {
    const container = containerRef.current
    const newQuery = searchedQuery.current !== query
    searchedQuery.current = query
    if (!container || query === '') {
      setRanges([])
      setIndex(-1)
      return
    }
    const { text, segments } = collectSearchableText(container)
    const found = findMatchRanges(text, query)
      .map((match) => rangeForMatch(container.ownerDocument, segments, match))
      .filter((range): range is Range => range !== null)
    setRanges(found)
    // A new query starts at the first match, but content that changed under a standing one must
    // not drag the reader back to the top of a document an agent is still writing.
    setIndex((current) => (found.length === 0 ? -1 : newQuery || current < 0 ? 0 : Math.min(current, found.length - 1)))
  }, [containerRef, contentKey, query])

  useEffect(() => {
    setFindHighlights(owner, ranges, index)
    const current = index >= 0 ? ranges[index] : null
    if (current && containerRef.current) scrollMatchIntoView(current, containerRef.current)
  }, [containerRef, index, owner, ranges])

  // The highlights are a document-wide registry, so a closed or unmounted bar has to hand its own back.
  useEffect(() => () => clearFindHighlights(owner), [owner])

  const step = useCallback(
    (direction: 1 | -1): void => setIndex((current) => stepMatchIndex(ranges.length, current, direction)),
    [ranges.length]
  )

  // Escape is bound on the window rather than on the bar: the reader can click into the prose to
  // read a match, and a handler scoped to the bar would leave no way to close it from there.
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      step(event.shiftKey ? -1 : 1)
    }
  }

  const count = query === '' ? '' : matchCountLabel(ranges.length, index)
  return (
    <div className="node-find-bar nodrag nowheel" role="search" onMouseDown={stopDrag} onKeyDown={onKeyDown}>
      <input
        ref={input}
        type="search"
        className="node-find-input"
        aria-label={label}
        placeholder="Find"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <span className="node-find-count" role="status" aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={ranges.length === 0}
        onMouseDown={stopDrag}
        onClick={() => step(-1)}
      >
        <ChevronUp aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={ranges.length === 0}
        onMouseDown={stopDrag}
        onClick={() => step(1)}
      >
        <ChevronDown aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Close search"
        title="Close search (Escape)"
        onMouseDown={stopDrag}
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  )
}
