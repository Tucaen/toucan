/**
 * The DOM half of in-node search: reading a rendered surface as one string, mapping a match back
 * onto a `Range`, scrolling to it, and painting it. Painting goes through the CSS Custom Highlight
 * API rather than wrapping matches in `<mark>` elements, because every surface this searches is
 * rendered by React - inserting elements into React-owned DOM is undone by the next render and
 * corrupts its reconciliation in the meantime. A `Range` touches nothing.
 */
import type { TextMatch } from './node-search'

/** One text node's slice of the flattened text, so a match offset can be mapped back to it. */
export interface TextSegment {
  node: Text
  /** Offset of this node's first character in the flattened text. */
  start: number
}

export interface SearchableText {
  text: string
  segments: TextSegment[]
}

/**
 * Tags that keep their text on the same line as their neighbours. Everything else starts a new
 * block, and blocks are separated by a newline in the flattened text so a query cannot match
 * across the gap between two paragraphs, list items or table cells. A tag list rather than
 * computed styles: it is deterministic, costs no layout, and reads the same under jsdom.
 */
const INLINE_TAGS = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'CITE',
  'CODE',
  'DEL',
  'DFN',
  'EM',
  'I',
  'INS',
  'KBD',
  'MARK',
  'Q',
  'S',
  'SAMP',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'U',
  'VAR'
])

const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])

function blockAncestor(node: Text, root: Element): Element {
  let element = node.parentElement
  while (element && element !== root && INLINE_TAGS.has(element.tagName)) element = element.parentElement
  return element ?? root
}

/** Flattens a rendered element into the text a find bar searches, keeping the way back to the DOM. */
export function collectSearchableText(root: Element): SearchableText {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement && SKIPPED_TAGS.has(node.parentElement.tagName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
  })
  const segments: TextSegment[] = []
  let text = ''
  let previousBlock: Element | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    if (textNode.data === '') continue
    const block = blockAncestor(textNode, root)
    if (previousBlock && block !== previousBlock) text += '\n'
    previousBlock = block
    segments.push({ node: textNode, start: text.length })
    text += textNode.data
  }
  return { text, segments }
}

function locate(segments: TextSegment[], offset: number): { node: Text; offset: number } | null {
  // Offsets grow with the array, so the last segment starting at or before the offset owns it.
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (offset >= segment.start && offset <= segment.start + segment.node.data.length) {
      return { node: segment.node, offset: offset - segment.start }
    }
  }
  return null
}

/** The live `Range` covering one match, or null if the DOM moved on since the text was collected. */
export function rangeForMatch(document: Document, segments: TextSegment[], match: TextMatch): Range | null {
  const from = locate(segments, match.start)
  const to = locate(segments, match.end)
  if (!from || !to) return null
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

const SCROLLING_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])

/**
 * The nearest ancestor that actually scrolls, which is the box a match has to be brought into.
 * Overflowing content is not enough to qualify - an `overflow: visible` box also reports more
 * scroll height than client height, and writing `scrollTop` to one is silently discarded.
 */
function scrollParentOf(element: Element | null): Element | null {
  const view = element?.ownerDocument.defaultView
  if (!view) return null
  for (let candidate: Element | null = element; candidate; candidate = candidate.parentElement) {
    const overflowY = view.getComputedStyle(candidate).overflowY
    if (SCROLLING_OVERFLOW.has(overflowY) && candidate.scrollHeight > candidate.clientHeight) return candidate
  }
  return null
}

/**
 * Brings a match into view without moving anything that is already showing it. Geometry is read
 * from the range itself, so a match halfway down a long paragraph is centred rather than the
 * paragraph's top being scrolled to.
 */
export function scrollMatchIntoView(range: Range, container: Element): void {
  const scroller = scrollParentOf(container)
  if (!scroller || typeof range.getBoundingClientRect !== 'function') return
  const match = range.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  // jsdom, and a range in a collapsed or unrendered box, report nothing to scroll to.
  if (match.height === 0 && match.width === 0) return
  if (match.top >= box.top && match.bottom <= box.bottom) return
  scroller.scrollTop += match.top - box.top - (box.height - match.height) / 2
}

const MATCH_HIGHLIGHT = 'toucan-find-match'
const CURRENT_HIGHLIGHT = 'toucan-find-current'

/**
 * Highlights are one document-wide registry keyed by name, but several nodes can have a find bar
 * open at once, so each contributes under its own owner id and the two named highlights are
 * rebuilt from all of them. A browser without the API (and jsdom) simply shows no highlighting;
 * the count, navigation and scrolling are unaffected.
 */
const contributions = new Map<string, { others: Range[]; current: Range | null }>()

function highlightsSupported(): boolean {
  return typeof Highlight === 'function' && typeof CSS !== 'undefined' && !!CSS.highlights
}

function repaint(): void {
  if (!highlightsSupported()) return
  const others: Range[] = []
  const current: Range[] = []
  for (const contribution of contributions.values()) {
    others.push(...contribution.others)
    if (contribution.current) current.push(contribution.current)
  }
  if (others.length === 0) CSS.highlights.delete(MATCH_HIGHLIGHT)
  else CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...others))
  if (current.length === 0) CSS.highlights.delete(CURRENT_HIGHLIGHT)
  else CSS.highlights.set(CURRENT_HIGHLIGHT, new Highlight(...current))
}

export function setFindHighlights(owner: string, ranges: readonly Range[], currentIndex: number): void {
  const current = currentIndex >= 0 ? (ranges[currentIndex] ?? null) : null
  contributions.set(owner, { others: ranges.filter((range) => range !== current), current })
  repaint()
}

export function clearFindHighlights(owner: string): void {
  if (!contributions.delete(owner)) return
  repaint()
}
