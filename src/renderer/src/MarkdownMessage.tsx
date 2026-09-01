import { memo, useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element as HastElement, Nodes as HastNodes, RootContent } from 'hast'
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

export const remarkPlugins = [remarkGfm]

const components: Components = {
  ...markdownBlockComponents,
  /* GFM autolinks turn bare URLs into anchors; a plain <a> would navigate the app window away. */
  a(props) {
    const href = typeof props.href === 'string' ? props.href : undefined
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault()
          if (href) void window.terminalApi?.openExternal?.(href)
        }}
      >
        {props.children}
      </a>
    )
  }
}

function MarkdownMessage({ text }: { text: string }): JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default memo(MarkdownMessage)
