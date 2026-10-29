import { classifyMarkdownLink, fileUrlOf, opensInSystemViewer } from '../../shared/local-file-link'

/**
 * What clicking a link in rendered prose does, and what the link says it will do. One decision
 * rather than two: the behaviour and the tooltip are the same three-way split, and deriving them
 * separately in the component is how a link comes to promise one thing and do another.
 *
 * The split itself: a web URL leaves for the browser. A local path Toucan has a view for opens as
 * a file node on the canvas, which reads bytes and executes nothing; only inert media it cannot
 * render is handed to the OS. Where there is no canvas behind the surface, revealing the file in
 * the OS file manager is the most that can be promised - it never opens or executes anything.
 */
export type MarkdownLinkAction =
  | { kind: 'browser'; url: string; title: string }
  | { kind: 'system-viewer'; path: string; title: string }
  | { kind: 'file-node'; path: string; title: string }
  | { kind: 'reveal'; path: string; title: string }
  /** Nothing this href names can be opened, so it must not render as a link at all. */
  | { kind: 'none' }

export function markdownLinkAction(href: string | undefined, canOpenFileNode: boolean): MarkdownLinkAction {
  const target = classifyMarkdownLink(href)
  if (target.kind === 'unsupported') return { kind: 'none' }
  if (target.kind === 'external') {
    return { kind: 'browser', url: target.url, title: `Open ${target.url} in your browser` }
  }
  const { path } = target
  if (opensInSystemViewer(path)) return { kind: 'system-viewer', path, title: `Open ${path}` }
  if (canOpenFileNode) return { kind: 'file-node', path, title: `Open ${path} as a node on the canvas` }
  return { kind: 'reveal', path, title: `Reveal ${path} in the file manager` }
}

export interface LinkCopyChoice {
  label: string
  /** The exact text that lands on the clipboard. */
  text: string
}

/**
 * What a link's context menu offers to copy. A link that cannot be opened - a file outside the
 * workspace, a relative path with no base - is still worth having as text, so every link with a
 * target offers it, including the inert ones: the raw target is all an inert link has.
 */
export function linkCopyChoices(action: MarkdownLinkAction, href: string | undefined): LinkCopyChoice[] {
  if (action.kind === 'browser') return [{ label: 'Copy link', text: action.url }]
  if (action.kind === 'none') {
    // mdast percent-encodes every destination; a relative path reads better as it was written.
    const raw = href?.trim()
    return raw ? [{ label: 'Copy link target', text: readable(raw) }] : []
  }
  return [
    { label: 'Copy path', text: action.path },
    { label: 'Copy as file URL', text: fileUrlOf(action.path) }
  ]
}

function readable(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
