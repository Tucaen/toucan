import { memo, useContext, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkHardBreaks } from '../../shared/markdown-hard-breaks'
import type { Element as HastElement, Nodes as HastNodes, RootContent } from 'hast'
import { markdownLinkAction } from './markdown-link-action'
import { OpenFileContext } from './open-file-context'
import { highlightedCode } from './syntax-highlight'

/*
 * Transcript rendering re-runs on every streaming chunk, so highlighting cannot live in the
 * markdown pipeline: a rehype plugin would re-tokenize every code block in the message each time a
 * character arrives. Instead `pre` is replaced by a memoized `CodeBlock` keyed on its own text, so
 * only the block currently being streamed is ever re-highlighted - finished blocks above it hit
 * React.memo and cost nothing. `common` is highlight.js' 37-language bundle; anything else falls
 * back to plain (still copyable) text rather than pulling the full ~190-language set into the
 * renderer bundle.
 */
/** Flattens a hast subtree to its source text - what a copy button must put on the clipboard. */
function nodeText(node: HastNodes | RootContent | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value
  if ('children' in node) return node.children.map(nodeText).join('')
  return ''
}

function languageFromClassName(value: unknown): string | undefined {
  const names = Array.isArray(value) ? value : typeof value === 'string' ? value.split(' ') : []
  for (const name of names) {
    if (typeof name !== 'string') continue
    if (name.startsWith('language-')) return name.slice('language-'.length).toLowerCase()
  }
  return undefined
}

/** Renders lowlight's hast output; it only ever emits text and `<span class=...>` elements. */
function copyToClipboard(text: string): void {
  const bridge = window.terminalApi
  if (bridge?.copyText) {
    bridge.copyText(text)
    return
  }
  void navigator.clipboard?.writeText(text)
}

export const CodeBlock = memo(function CodeBlock(props: { code: string; language?: string }): JSX.Element {
  const { code, language } = props
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timer.current), [])

  const highlighted = highlightedCode(code, language)

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-language">{language ?? 'text'}</span>
        <button
          type="button"
          className="code-block-copy"
          aria-label={`Copy ${language ?? 'code'} block`}
          onClick={() => {
            copyToClipboard(code)
            setCopied(true)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1400)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code className="hljs">{highlighted}</code>
      </pre>
    </div>
  )
})

/**
 * Every Markdown block override Toucan shares, with no opinion about where a link goes. Transcripts
 * send links straight to the browser; the brain-dump reader has topic and local-file links to tell
 * apart first, so each caller supplies its own `a` on top of these.
 */
export const markdownBlockComponents: Components = {
  /*
   * Overriding `pre` rather than `code` keeps inline code untouched and lets the fenced block be
   * read straight off the hast node, so the copied text is exactly the block's contents - no
   * fence, no language label, and no trailing newline the parser added.
   */
  pre(props) {
    const node = props.node as HastElement | undefined
    const code = node?.children.find(
      (child): child is HastElement => child.type === 'element' && child.tagName === 'code'
    )
    if (!code) return <pre>{props.children}</pre>
    return (
      <CodeBlock
        code={nodeText(code).replace(/\n$/, '')}
        language={languageFromClassName(code.properties?.className)}
      />
    )
  },
  /* Tables scroll inside the message instead of stretching the node past its width. */
  table(props) {
    return (
      <div className="markdown-table-scroll">
        <table>{props.children}</table>
      </div>
    )
  }
}

/**
 * react-markdown's default URL sanitizer keeps a handful of web schemes and blanks everything
 * else, including `file:` and any bare Windows path (`D:/x` reads as scheme `d:`), which is
 * exactly the local artifact link this pipeline exists to open. Safety is enforced afterwards
 * instead: `classifyMarkdownLink` decides what an href is, and anything it does not recognize
 * renders as inert text with no `href` at all.
 */
export const keepHref = (url: string): string => url

export const remarkPlugins = [remarkGfm]

/** For text a person typed by hand; markdown-hard-breaks.ts says why agent output is left out. */
export const authoredRemarkPlugins = [remarkGfm, remarkHardBreaks]

/**
 * One link in agent prose, rendering whatever `markdownLinkAction` decided it does - the component
 * makes no such decision of its own. Two details are load-bearing. A refusal is shown beside the
 * link rather than swallowed, because a link that silently does nothing is indistinguishable from
 * a broken app, which is what issue #175 was. And only a web link carries a real `href`: a click
 * is intercepted, but a middle-click or a link-drag is not, and neither may hand the app window a
 * local path to navigate to.
 */
function MarkdownLink(props: { href?: string; children?: React.ReactNode }): JSX.Element {
  const openFileNode = useContext(OpenFileContext)
  const action = markdownLinkAction(props.href, openFileNode !== null)
  const [problem, setProblem] = useState<string>()

  if (action.kind === 'none') return <span className="markdown-inert-link">{props.children}</span>

  const bridge = window.terminalApi
  const open = (): void => {
    setProblem(undefined)
    if (action.kind === 'browser') {
      void bridge?.openExternal?.(action.url)
      return
    }
    if (action.kind === 'file-node') {
      openFileNode?.(action.path)
      return
    }
    if (action.kind === 'reveal') {
      void bridge?.showItemInFolder?.(action.path)
      return
    }
    const opening = bridge?.openLocalFile?.(action.path)
    if (opening === undefined) {
      setProblem('This build cannot open local files.')
      return
    }
    void opening
      .then((result) => {
        if (!result.ok) setProblem(result.message)
      })
      .catch((error: Error) => setProblem(error.message))
  }

  return (
    <>
      <a
        href={action.kind === 'browser' ? action.url : undefined}
        // Without an href an anchor is not a link to the keyboard or a screen reader; a local
        // artifact link is still a link, so it says so explicitly instead.
        role={action.kind === 'browser' ? undefined : 'link'}
        tabIndex={action.kind === 'browser' ? undefined : 0}
        title={action.title}
        data-link-kind={action.kind}
        onClick={(event) => {
          event.preventDefault()
          open()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          open()
        }}
      >
        {props.children}
      </a>
      {problem && (
        <span className="markdown-link-error" role="note">
          {problem}
        </span>
      )}
    </>
  )
}

const components: Components = {
  ...markdownBlockComponents,
  a(props) {
    return <MarkdownLink href={typeof props.href === 'string' ? props.href : undefined}>{props.children}</MarkdownLink>
  }
}

function MarkdownMessage({ text, authored }: { text: string; authored?: boolean }): JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={authored ? authoredRemarkPlugins : remarkPlugins}
        components={components}
        urlTransform={keepHref}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default memo(MarkdownMessage)
