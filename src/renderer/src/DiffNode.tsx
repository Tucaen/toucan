import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { NodeProps } from '@xyflow/react'
import { GitCompare, RefreshCw } from 'lucide-react'
import type { GitChangedFile, GitDiffSummary, GitFileDiff } from '../../shared/git-diff'
import type { DiffCanvasNode } from './canvas-workspace'
import {
  describeDiffBase,
  describeDiffStatus,
  diffCountsLabel,
  diffStatusGlyph,
  hunkBlock,
  retainedSelection
} from './diff-node'
import { joinWorkspacePath } from './file-node'
import { FileOperationBlockView } from './FileOperationCard'
import NodeBorderResizer from './NodeBorderResizer'
import NodeFitAction from './NodeFitAction'

/** The same tick the worktree node's status badge polls on, so the two never disagree for long. */
const REFRESH_POLL_MS = 10_000

const stopDrag = (event: React.MouseEvent): void => event.stopPropagation()

function failureText(summary: Extract<GitDiffSummary, { ok: false }>): string {
  switch (summary.reason) {
    case 'missing':
      return 'This directory is not on disk any more.'
    case 'not-a-repository':
      return 'This directory is not a git repository, so there is nothing to diff.'
    case 'failed':
      return summary.message
  }
}

/**
 * Whether the node is worth a git run right now: the app is visible and the node is somewhere on
 * screen. Nothing is polled for a node scrolled off the canvas or an app in the background; the
 * next visible tick catches up. Where the observer API is missing (jsdom) the node counts as seen.
 */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): () => boolean {
  const onScreen = useRef(true)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      onScreen.current = entries.some((entry) => entry.isIntersecting)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return useCallback(() => onScreen.current && document.visibilityState !== 'hidden', [])
}

/**
 * One checkout's changes against its base, reviewed without leaving the canvas. The file list is
 * read from git on mount, on the same tick the worktree badge polls, and on Refresh; hunks are
 * read one file at a time, only for the file the reader opens, so a large review never costs a
 * whole-tree diff. Which file is open is node data, so a restart reopens the same review.
 */
export default function DiffNode({ id, data, selected }: NodeProps<DiffCanvasNode>): JSX.Element {
  const { path, baseRef, selectedPath, onSelectDiffPath } = data
  const [summary, setSummary] = useState<GitDiffSummary | null>(null)
  const [fileDiff, setFileDiff] = useState<GitFileDiff | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const articleRef = useRef<HTMLElement>(null)
  const isVisible = useOnScreen(articleRef)
  const generation = useRef(0)
  const fileGeneration = useRef(0)
  const selectedRef = useRef(selectedPath)
  selectedRef.current = selectedPath

  const loadFile = useCallback(
    async (file: GitChangedFile): Promise<void> => {
      const ticket = ++fileGeneration.current
      const next = await window.worktreeApi
        .diffFile({ path, baseRef, file })
        .catch((error: unknown): GitFileDiff => ({ ok: false, message: (error as Error).message }))
      if (ticket === fileGeneration.current) setFileDiff(next)
    },
    [baseRef, path]
  )

  const refresh = useCallback(async (): Promise<void> => {
    const ticket = ++generation.current
    setRefreshing(true)
    const next = await window.worktreeApi
      .diff({ path, baseRef })
      .catch((error: unknown): GitDiffSummary => ({ ok: false, reason: 'failed', message: (error as Error).message }))
    if (ticket !== generation.current) return
    setRefreshing(false)
    setSummary(next)
    const files = next.ok ? next.files : []
    const retained = retainedSelection(files, selectedRef.current)
    if (retained !== selectedRef.current) {
      onSelectDiffPath(id, retained)
      setFileDiff(null)
      return
    }
    const open = files.find((file) => file.path === retained)
    if (open) void loadFile(open)
    // Deliberately not `data`: selecting a file rebuilds the node's data object, and re-running the
    // mount effect on that would re-read the whole list and blank the pane on every click.
  }, [baseRef, id, loadFile, onSelectDiffPath, path])

  useEffect(() => {
    setSummary(null)
    setFileDiff(null)
    void refresh()
    const interval = setInterval(() => {
      if (isVisible()) void refresh()
    }, REFRESH_POLL_MS)
    return () => {
      clearInterval(interval)
      generation.current += 1
      fileGeneration.current += 1
    }
  }, [isVisible, refresh])

  const select = (file: GitChangedFile): void => {
    if (file.path === selectedPath) return
    onSelectDiffPath(id, file.path)
    setFileDiff(null)
    void loadFile(file)
  }

  const files = summary?.ok ? summary.files : []
  const selectedFile = files.find((file) => file.path === selectedPath)
  const absolute = selectedFile ? joinWorkspacePath(path, selectedFile.path) : undefined

  return (
    <article
      ref={articleRef}
      className={`diff-node ${selected ? 'selected' : ''}`}
      style={{ '--project-color': data.projectColor } as React.CSSProperties}
    >
      <NodeBorderResizer minWidth={420} minHeight={240} selected={selected} color={data.projectColor} />
      <header className="node-header diff-node-header">
        <span className="diff-node-glyph" aria-hidden="true">
          <GitCompare />
        </span>
        <strong title={path}>{describeDiffBase(summary, data.label, baseRef)}</strong>
        <span className="node-project" title={data.projectPath}>
          <span className="project-color-dot" />
          {data.projectName}
        </span>
        {summary?.ok && <span className="node-status">{files.length === 1 ? '1 file' : `${files.length} files`}</span>}
        <button
          type="button"
          className="diff-node-refresh nodrag"
          title="Re-read the changes from git"
          aria-label="Refresh"
          disabled={refreshing}
          onMouseDown={stopDrag}
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <NodeFitAction nodeId={id} fitted={data.fittedToCanvas ?? false} />
      </header>

      <div className="diff-node-body nodrag nowheel">
        {summary === null && <p className="diff-node-notice">Reading changes…</p>}
        {summary && !summary.ok && (
          <p className="diff-node-notice" data-reason={summary.reason} role="status">
            {failureText(summary)}
          </p>
        )}
        {summary?.ok && files.length === 0 && (
          <p className="diff-node-notice" role="status">
            No changes against {baseRef}.
          </p>
        )}
        {summary?.ok && files.length > 0 && (
          <>
            <div className="diff-node-rail" role="listbox" aria-label="Changed files">
              {files.map((file) => {
                const counts = diffCountsLabel(file)
                return (
                  <button
                    type="button"
                    role="option"
                    key={file.path}
                    className="diff-node-file"
                    aria-selected={file.path === selectedPath}
                    title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    onMouseDown={stopDrag}
                    onClick={() => select(file)}
                  >
                    <span
                      className="diff-node-status"
                      data-status={file.status}
                      aria-label={describeDiffStatus(file.status)}
                    >
                      {diffStatusGlyph(file.status)}
                    </span>
                    <span className="diff-node-file-path">{file.path}</span>
                    {counts && <span className="diff-node-counts">{counts}</span>}
                  </button>
                )
              })}
            </div>
            <div className="diff-node-pane">
              {!selectedFile && <p className="diff-node-notice">Select a file to see its changes.</p>}
              {selectedFile && fileDiff === null && <p className="diff-node-notice">Loading {selectedFile.path}…</p>}
              {selectedFile && fileDiff && !fileDiff.ok && (
                <p className="diff-node-notice" data-reason="failed" role="alert">
                  {fileDiff.message}
                </p>
              )}
              {selectedFile && fileDiff?.ok && fileDiff.binary && (
                <p className="diff-node-notice" data-reason="binary" role="status">
                  Binary file · {describeDiffStatus(selectedFile.status).toLowerCase()}. Toucan shows text changes only.
                </p>
              )}
              {selectedFile && fileDiff?.ok && !fileDiff.binary && fileDiff.hunks.length === 0 && (
                <p className="diff-node-notice" role="status">
                  {describeDiffStatus(selectedFile.status)} with no line changes to show.
                </p>
              )}
              {selectedFile && absolute && fileDiff?.ok && fileDiff.hunks.length > 0 && (
                <div className="file-op">
                  {fileDiff.hunks.map((hunk, index) => (
                    <FileOperationBlockView
                      block={hunkBlock(hunk, absolute)}
                      key={`${selectedFile.path}:${index}`}
                      showPath={index === 0}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  )
}
