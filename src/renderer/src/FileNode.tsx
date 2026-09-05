import { useCallback, useEffect, useMemo, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { FileText } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { fileViewPathIdentity, isMarkdownPath, type FileReadResult, type FileViewMode } from '../../shared/file-view'
import type { FileCanvasNode } from './canvas-workspace'
import { describeFileReadFailure, fileNodeName, RAW_HIGHLIGHT_LINE_LIMIT, rawFileLines } from './file-node'
import { byteLength, formatByteSize, shortenFilePath } from './file-operation'
import { markdownBlockComponents, remarkPlugins } from './MarkdownMessage'
import NodeBorderResizer from './NodeBorderResizer'
import NodeFitAction from './NodeFitAction'
import { highlightedCodeLines } from './syntax-highlight'

/**
 * Only web links leave the node; a relative link to another file or an anchor inside the document
 * has nowhere safe to go yet, so it renders as inert text rather than navigating the window.
 */
const components: Components = {
  ...markdownBlockComponents,
  a(props) {
    const href = typeof props.href === 'string' ? props.href : undefined
    if (!href || !/^https?:\/\//i.test(href)) return <span className="file-node-inert-link">{props.children}</span>
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault()
          void window.terminalApi?.openExternal?.(href)
        }}
      >
        {props.children}
      </a>
    )
  }
}

function RawLines({ content, path }: { content: string; path: string }): JSX.Element {
  const lines = useMemo(() => rawFileLines(content), [content])
  const highlighted = useMemo(
    () => (lines.length > RAW_HIGHLIGHT_LINE_LIMIT ? lines.map((line) => [line]) : highlightedCodeLines(lines, path)),
    [lines, path]
  )
  return (
    <div className="file-node-lines">
      {lines.map((_line, index) => (
        <div className="file-node-line" key={index}>
          <span className="file-node-line-number" aria-hidden="true">
            {index + 1}
          </span>
          <span className="file-node-line-text">
            <code className="hljs">{highlighted[index]}</code>
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * One project file on the canvas, read-only and live. The node owns nothing but its geometry and
 * view choice; the bytes are read through `fileViewApi` on mount and again whenever main reports
 * the file changed, so a document an agent is writing updates beside the chat producing it.
 */
export default function FileNode({ id, data, selected }: NodeProps<FileCanvasNode>): JSX.Element {
  const { path, view } = data
  const [result, setResult] = useState<FileReadResult | null>(null)
  const markdown = isMarkdownPath(path)
  const mode: FileViewMode = markdown ? view : 'raw'

  const read = useCallback(async (): Promise<void> => {
    const next = await window.fileViewApi.read(path).catch((error: unknown): FileReadResult => ({
      ok: false,
      reason: 'unreadable',
      message: (error as Error).message
    }))
    setResult(next)
  }, [path])

  useEffect(() => {
    let active = true
    // Bound once so the watch that was started is the one released, whatever the bridge looks
    // like by the time the node unmounts.
    const api = window.fileViewApi
    setResult(null)
    void read()
    void api.watch(path)
    const identity = fileViewPathIdentity(path)
    const stop = api.onChange((changed) => {
      if (active && fileViewPathIdentity(changed) === identity) void read()
    })
    return () => {
      active = false
      stop()
      void api.unwatch(path)
    }
  }, [path, read])

  const setMode = (next: FileViewMode): void => {
    if (next !== view) data.onViewModeChange(id, next)
  }

  return (
    <article
      className={`file-node ${selected ? 'selected' : ''}`}
      style={{ '--project-color': data.projectColor } as React.CSSProperties}
    >
      <NodeBorderResizer minWidth={320} minHeight={200} selected={selected} color={data.projectColor} />
      <header className="node-header file-node-header">
        <span className="file-node-glyph" aria-hidden="true">
          <FileText />
        </span>
        <strong title={path}>{fileNodeName(path)}</strong>
        <span className="file-node-path" title={path}>
          {shortenFilePath(path, [data.projectPath])}
        </span>
        <span className="file-node-actions nodrag">
          {markdown && (
            <span className="file-node-view-toggle" role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={mode === 'rendered'}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setMode('rendered')}
              >
                Rendered
              </button>
              <button
                type="button"
                aria-pressed={mode === 'raw'}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setMode('raw')}
              >
                Raw
              </button>
            </span>
          )}
          <button
            type="button"
            title={path}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => window.terminalApi?.copyText(path)}
          >
            Copy path
          </button>
          {window.terminalApi?.showItemInFolder && (
            <button
              type="button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void window.terminalApi.showItemInFolder(path)}
            >
              Reveal
            </button>
          )}
        </span>
        <NodeFitAction nodeId={id} fitted={data.fittedToCanvas ?? false} />
      </header>

      <div className="file-node-body nodrag nowheel" data-view={mode}>
        {result === null && <p className="file-node-notice">Reading…</p>}
        {result && !result.ok && (
          <p className="file-node-notice" data-reason={result.reason} role="status">
            {describeFileReadFailure(result.reason, result.message)}
          </p>
        )}
        {result?.ok && result.binary && (
          <p className="file-node-notice" data-reason="binary" role="status">
            Binary file · {formatByteSize(result.size)}. Toucan shows text files only.
          </p>
        )}
        {result?.ok && !result.binary && (
          <>
            {result.truncated && (
              <p className="file-node-notice" data-reason="truncated" role="status">
                Showing the first {formatByteSize(byteLength(result.content))} of {formatByteSize(result.size)}.
              </p>
            )}
            {mode === 'rendered' ? (
              <div className="markdown-body file-node-prose">
                <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
                  {result.content}
                </ReactMarkdown>
              </div>
            ) : (
              <RawLines content={result.content} path={path} />
            )}
          </>
        )}
      </div>
    </article>
  )
}
