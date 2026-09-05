import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { FileText } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import {
  fileViewPathIdentity,
  isMarkdownPath,
  type FileReadResult,
  type FileViewMode,
  type FileWriteResult
} from '../../shared/file-view'
import type { FileCanvasNode } from './canvas-workspace'
import CodeEditor from './CodeEditor'
import {
  describeFileReadFailure,
  describeFileWriteFailure,
  editStateAfterEdit,
  editStateAfterRead,
  editStateAfterSave,
  fileEditability,
  fileNodeName,
  isDirty,
  keepDraftOverDisk,
  UNEDITED,
  type FileEditState
} from './file-node'
import { byteLength, formatByteSize, shortenFilePath } from './file-operation'
import { markdownBlockComponents, remarkPlugins } from './MarkdownMessage'
import NodeBorderResizer from './NodeBorderResizer'
import NodeFitAction from './NodeFitAction'

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

const stopDrag = (event: React.MouseEvent): void => event.stopPropagation()

const NOT_READ: FileReadResult = { ok: false, reason: 'not-found', message: 'This file is not on disk any more.' }

/**
 * One project file on the canvas, live and editable. The node owns its geometry and view choice;
 * the bytes are read through `fileViewApi` on mount and again whenever main reports the file
 * changed, so a document an agent is writing updates beside the chat producing it. The raw view is
 * the editor: typing makes a draft, Save (or Ctrl+S) writes it back through main's in-project
 * guard, and disk stays the truth - a change that lands under a draft is shown as a conflict the
 * reader resolves, never overwritten and never allowed to overwrite the draft.
 */
export default function FileNode({ id, data, selected }: NodeProps<FileCanvasNode>): JSX.Element {
  const { path, view } = data
  const [result, setResult] = useState<FileReadResult | null>(null)
  const [edit, setEdit] = useState<FileEditState>(UNEDITED)
  const [saveFailure, setSaveFailure] = useState<Extract<FileWriteResult, { ok: false }> | null>(null)
  const [saving, setSaving] = useState(false)
  const editRef = useRef(edit)
  editRef.current = edit
  const resultRef = useRef(result)
  resultRef.current = result
  const markdown = isMarkdownPath(path)
  const mode: FileViewMode = markdown ? view : 'raw'
  const editability = fileEditability(result)
  const dirty = isDirty(edit)

  const read = useCallback(async (): Promise<void> => {
    const next = await window.fileViewApi.read(path).catch((error: unknown): FileReadResult => ({
      ok: false,
      reason: 'unreadable',
      message: (error as Error).message
    }))
    setResult(next)
    setEdit((state) => editStateAfterRead(state, next))
  }, [path])

  useEffect(() => {
    let active = true
    // Bound once so the watch that was started is the one released, whatever the bridge looks
    // like by the time the node unmounts.
    const api = window.fileViewApi
    setResult(null)
    setEdit(UNEDITED)
    setSaveFailure(null)
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

  const onEdit = useCallback((text: string): void => {
    const disk = resultRef.current
    if (!disk?.ok) return
    setEdit((state) => editStateAfterEdit(state, text, disk))
    setSaveFailure(null)
  }, [])

  const save = useCallback(async (): Promise<void> => {
    const state = editRef.current
    if (state.draft === null || state.baseMtime === null || state.conflict) return
    setSaving(true)
    const written = await window.fileViewApi
      .write({ path, content: state.draft, baseMtime: state.baseMtime })
      .catch((error: unknown): FileWriteResult => ({
        ok: false,
        reason: 'unwritable',
        message: (error as Error).message
      }))
    setSaving(false)
    if (!written.ok) {
      if (written.reason === 'conflict' || written.reason === 'not-found') {
        // The guard refused because disk moved on: the same conflict the watcher would have
        // raised, resolved the same way, with a re-read to show what is there now beside the draft.
        setEdit((state) => (state.conflict ? state : { ...state, conflict: true }))
        void read()
      } else {
        setSaveFailure(written)
      }
      return
    }
    setSaveFailure(null)
    setResult((current) =>
      current?.ok
        ? { ...current, content: state.draft ?? current.content, mtime: written.mtime, size: written.size }
        : current
    )
    setEdit(editStateAfterSave(written.mtime))
  }, [path, read])

  /** Back to the file as it is on disk; also how a conflict is resolved in disk's favour. */
  const discard = (): void => {
    setEdit(editStateAfterRead(UNEDITED, resultRef.current ?? NOT_READ))
    setSaveFailure(null)
  }

  /** The draft wins the conflict: rebased on disk so the next save is accepted, still unsaved. */
  const keepDraft = (): void => {
    setEdit((state) => keepDraftOverDisk(state, resultRef.current ?? NOT_READ))
    setSaveFailure(null)
  }

  // The draft outranks disk, including a disk that has nothing to show any more.
  const shownContent = edit.draft ?? (result?.ok ? result.content : '')
  const canSave = dirty && !edit.conflict && !saving && editability.editable

  return (
    <article
      className={`file-node ${selected ? 'selected' : ''}`}
      data-dirty={dirty || undefined}
      style={{ '--project-color': data.projectColor } as React.CSSProperties}
    >
      <NodeBorderResizer minWidth={320} minHeight={200} selected={selected} color={data.projectColor} />
      <header className="node-header file-node-header">
        <span className="file-node-glyph" aria-hidden="true">
          <FileText />
        </span>
        <strong title={path}>
          {fileNodeName(path)}
          {dirty && (
            <span className="file-node-dirty" title="Unsaved changes" aria-label="Unsaved changes">
              ●
            </span>
          )}
        </strong>
        <span className="file-node-path" title={path}>
          {shortenFilePath(path, [data.projectPath])}
        </span>
        <span className="file-node-actions nodrag">
          {dirty && (
            <>
              <button
                type="button"
                className="file-node-save"
                title="Save (Ctrl+S)"
                disabled={!canSave}
                onMouseDown={stopDrag}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onMouseDown={stopDrag} onClick={discard}>
                Discard
              </button>
            </>
          )}
          {markdown && (
            <span className="file-node-view-toggle" role="group" aria-label="View">
              <button
                type="button"
                aria-pressed={mode === 'rendered'}
                onMouseDown={stopDrag}
                onClick={() => setMode('rendered')}
              >
                Rendered
              </button>
              <button type="button" aria-pressed={mode === 'raw'} onMouseDown={stopDrag} onClick={() => setMode('raw')}>
                {editability.editable ? 'Edit' : 'Raw'}
              </button>
            </span>
          )}
          <button type="button" title={path} onMouseDown={stopDrag} onClick={() => window.terminalApi?.copyText(path)}>
            Copy path
          </button>
          {window.terminalApi?.showItemInFolder && (
            <button type="button" onMouseDown={stopDrag} onClick={() => void window.terminalApi.showItemInFolder(path)}>
              Reveal
            </button>
          )}
        </span>
        <NodeFitAction nodeId={id} fitted={data.fittedToCanvas ?? false} />
      </header>

      <div className="file-node-body nodrag nowheel" data-view={mode}>
        {result === null && <p className="file-node-notice">Reading…</p>}
        {result && !result.ok && !dirty && (
          <p className="file-node-notice" data-reason={result.reason} role="status">
            {describeFileReadFailure(result.reason, result.message)}
          </p>
        )}
        {result?.ok && result.binary && (
          <p className="file-node-notice" data-reason="binary" role="status">
            Binary file · {formatByteSize(result.size)}. Toucan shows text files only.
          </p>
        )}
        {edit.conflict && (
          <div className="file-node-conflict" role="alert" data-reason={result?.ok ? 'changed' : 'gone'}>
            <p>
              {result?.ok
                ? 'This file changed on disk while you were editing it. Your edits are still here and nothing was written.'
                : 'This file is gone from disk while you were editing it. Your edits are still here and nothing was written.'}
            </p>
            <span className="file-node-conflict-actions">
              <button type="button" onMouseDown={stopDrag} onClick={discard}>
                {result?.ok ? 'Reload from disk' : 'Drop my edits'}
              </button>
              {result?.ok && (
                <button type="button" onMouseDown={stopDrag} onClick={keepDraft}>
                  Keep my edits
                </button>
              )}
            </span>
          </div>
        )}
        {saveFailure && !edit.conflict && (
          <p className="file-node-notice" data-reason={saveFailure.reason} role="alert">
            {describeFileWriteFailure(saveFailure.reason, saveFailure.message)}
          </p>
        )}
        {(result?.ok && !result.binary) || dirty ? (
          <>
            {result?.ok && result.truncated && (
              <p className="file-node-notice" data-reason="truncated" role="status">
                Showing the first {formatByteSize(byteLength(result.content))} of {formatByteSize(result.size)}; a
                partial file cannot be edited here.
              </p>
            )}
            {mode === 'rendered' ? (
              <div className="markdown-body file-node-prose">
                <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
                  {shownContent}
                </ReactMarkdown>
              </div>
            ) : (
              <CodeEditor
                value={shownContent}
                path={path}
                readOnly={!editability.editable && !dirty}
                onChange={onEdit}
                onSave={() => void save()}
              />
            )}
          </>
        ) : null}
      </div>
    </article>
  )
}
