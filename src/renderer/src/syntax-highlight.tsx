import { common, createLowlight } from 'lowlight'
import type { Element as HastElement, RootContent } from 'hast'
import type { ReactNode } from 'react'

const lowlight = createLowlight(common)

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', html: 'html', java: 'java',
  js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown', py: 'python', rb: 'ruby',
  rs: 'rust', sh: 'bash', sql: 'sql', ts: 'typescript', tsx: 'typescript', xml: 'xml', yaml: 'yaml', yml: 'yaml'
}

function renderHast(nodes: RootContent[], keyPrefix = 'h'): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`
    if (node.type === 'text') return node.value
    if (node.type !== 'element') return null
    const className = node.properties?.className
    return <span key={key} className={Array.isArray(className) ? className.join(' ') : undefined}>
      {renderHast(node.children as RootContent[], key)}
    </span>
  })
}

export function highlightedCode(code: string, language?: string): ReactNode {
  return language && lowlight.registered(language)
    ? renderHast(lowlight.highlight(language, code).children as RootContent[])
    : code
}

export function languageForPath(path: string): string | undefined {
  const extension = path.replace(/\\/g, '/').split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? ''
  return LANGUAGE_BY_EXTENSION[extension]
}

function appendText(lines: ReactNode[][], text: string): void {
  const parts = text.split('\n')
  parts.forEach((part, index) => {
    if (index > 0) lines.push([])
    if (part) lines.at(-1)!.push(part)
  })
}

function splitHighlightedNodes(nodes: RootContent[], keyPrefix = 'l'): ReactNode[][] {
  const lines: ReactNode[][] = [[]]
  nodes.forEach((node, index) => {
    if (node.type === 'text') {
      appendText(lines, node.value)
      return
    }
    if (node.type !== 'element') return
    const childLines = splitHighlightedNodes(node.children as RootContent[], `${keyPrefix}-${index}`)
    const className = Array.isArray(node.properties?.className) ? node.properties.className.join(' ') : undefined
    childLines.forEach((children, childIndex) => {
      if (childIndex > 0) lines.push([])
      lines.at(-1)!.push(<span className={className} key={`${keyPrefix}-${index}-${childIndex}`}>{children}</span>)
    })
  })
  return lines
}

/** Highlights all lines in one pass, preserving lexer state across multiline constructs. */
export function highlightedCodeLines(lines: string[], path: string): ReactNode[][] {
  const language = languageForPath(path)
  if (!language || !lowlight.registered(language)) return lines.map((line) => [line])
  const root = lowlight.highlight(language, lines.join('\n')).children as RootContent[]
  const highlighted = splitHighlightedNodes(root)
  while (highlighted.length < lines.length) highlighted.push([])
  return highlighted.slice(0, lines.length)
}
