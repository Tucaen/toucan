import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { common, createLowlight } from 'lowlight'
import type { Element as HastElement, Nodes as HastNodes, RootContent } from 'hast'

/*
 * Transcript rendering re-runs on every streaming chunk, so highlighting cannot live in the
 * markdown pipeline: a rehype plugin would re-tokenize every code block in the message each time a
 * character arrives. Instead `pre` is replaced by a memoized `CodeBlock` keyed on its own text, so
 * only the block currently being streamed is ever re-highlighted - finished blocks above it hit
 * React.memo and cost nothing. `common` is highlight.js' 37-language bundle; anything else falls
 * back to plain (still copyable) text rather than pulling the full ~190-language set into the
 * renderer bundle.
 */
const lowlight = createLowlight(common)

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
function renderHast(nodes: RootContent[], keyPrefix = 'h'): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`
    if (node.type === 'text') return node.value
    if (node.type !== 'element') return null
    const className = node.properties?.className
    return (
      <span key={key} className={Array.isArray(className) ? className.join(' ') : undefined}>
        {renderHast(node.children as RootContent[], key)}
      </span>
    )
  })
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', html: 'html', java: 'java',
  js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown', py: 'python', rb: 'ruby',
  rs: 'rust', sh: 'bash', sql: 'sql', ts: 'typescript', tsx: 'typescript', xml: 'xml', yaml: 'yaml', yml: 'yaml'
}

/** Syntax-highlights a code fragment using the same bounded language bundle as transcript fences. */
export function HighlightedCodeText({ code, path }: { code: string; path: string }): JSX.Element {
  const extension = path.replace(/\\/g, '/').split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? ''
  const language = LANGUAGE_BY_EXTENSION[extension]
  const highlighted = language && lowlight.registered(language)
    ? renderHast(lowlight.highlight(language, code).children as RootContent[])
    : code
  return <code className="hljs">{highlighted}</code>
}

function copyToClipboard(text: string): void {
  const bridge = window.terminalApi
  if (bridge?.copyText) {
    bridge.copyText(text)
    return
  }
  void navigator.clipboard?.writeText(text)
}

export const CodeBlock = memo(function CodeBlock(
  props: { code: string; language?: string }
): JSX.Element {
  const { code, language } = props
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timer.current), [])

  const highlighted = language && lowlight.registered(language)
    ? renderHast(lowlight.highlight(language, code).children as RootContent[])
    : code

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
      <pre><code className="hljs">{highlighted}</code></pre>
    </div>
  )
})

const components: Components = {
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
  /* GFM autolinks turn bare URLs into anchors; a plain <a> would navigate the app window away. */
  a(props) {
    const href = typeof props.href === 'string' ? props.href : undefined
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault()
          if (href) window.terminalApi?.openExternal?.(href)
        }}
      >
        {props.children}
      </a>
    )
  },
  /* Tables scroll inside the message instead of stretching the node past its width. */
  table(props) {
    return <div className="markdown-table-scroll"><table>{props.children}</table></div>
  }
}

const remarkPlugins = [remarkGfm]

function MarkdownMessage({ text }: { text: string }): JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>{text}</ReactMarkdown>
    </div>
  )
}

export default memo(MarkdownMessage)
