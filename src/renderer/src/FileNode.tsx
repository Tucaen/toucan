import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NodeProps } from '@xyflow/react'
import { FileText } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { frontmatterForDisplay } from '../../shared/frontmatter'
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
  editStateAfterRefusedSave,
  editStateAfterSave,
  fileEditability,
  fileNodeName,
  isDirty,
  keepDraftOverDisk,
  UNEDITED,
  type FileEditState
} from './file-node'
import { byteLength, formatByteSize, shortenFilePath } from './file-operation'
import FindBar from './FindBar'
import { markdownBlockComponents, remarkPlugins } from './MarkdownMessage'
import NodeBorderResizer from './NodeBorderResizer'
import NodeFitAction from './NodeFitAction'
import { useNodeSearchRequest } from './node-search-context'

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

const NOTHING_ON_DISK: FileReadResult = {
  ok: false,
  reason: 'not-found',
  message: 'This file is not on disk any more.'
}

type SaveOutcome = 'saved' | 'still-dirty' | 'failed'

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
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const savingRef = useRef(false)
  const readGenerationRef = useRef(0)
  const editRef = useRef(edit)
  editRef.current = edit
  const resultRef = useRef(result)
  resultRef.current = result
  const fileIdentityRef = useRef<HTMLButtonElement>(null)
  const proseRef = useRef<HTMLDivElement>(null)
  const pendingDialogRef = useRef<HTMLDivElement>(null)
  const hadPendingPathRef = useRef(false)
  const pendingFileChangeTitleId = useId()
  const markdown = isMarkdownPath(path)
  const mode: FileViewMode = markdown ? view : 'raw'
  const editability = fileEditability(result)
  const dirty = isDirty(edit)
  const [findBar, setFindBar] = useState<{ open: boolean; signal: number }>({ open: false, signal: 0 })
  const [editorSearchSignal, setEditorSearchSignal] = useState(0)

  useNodeSearchRequest(
    id,
    useCallback(() => {
      // The node's own unsaved-changes dialog is modal over this node but invisible to the canvas's
      // `dialogOpen`, so opening a search behind it is this node's to refuse.
      if (pendingPath) return
      if (mode === 'rendered') setFindBar((current) => ({ open: true, signal: current.signal + 1 }))
      else setEditorSearchSignal((current) => current + 1)
    }, [mode, pendingPath])
  )

  const closeFindBar = useCallback((): void => setFindBar((current) => ({ ...current, open: false })), [])

  // The two views search differently, so a find bar left over from the rendered view would count
  // matches in prose that is no longer on screen.
  useEffect(() => {
    if (mode !== 'rendered') closeFindBar()
  }, [closeFindBar, mode])

  const read = useCallback(async (): Promise<void> => {
    const generation = ++readGenerationRef.current
    const next = await window.fileViewApi.read(path).catch((error: unknown): FileReadResult => ({
      ok: false,
      reason: 'unreadable',
      message: (error as Error).message
    }))
    if (generation !== readGenerationRef.current) return
    setResult(next)
    setEdit((state) => editStateAfterRead(state, next))
  }, [path])

  useEffect(() => {
    if (pendingPath) {
      hadPendingPathRef.current = true
      const dialog = pendingDialogRef.current
      if (!dialog) return
      const firstAction = dialog.querySelector<HTMLButtonElement>('button:not(:disabled)')
      const focused = document.activeElement
      if (saving || !firstAction) dialog.focus()
      else if (
        focused === dialog ||
        !dialog.contains(focused) ||
        (focused instanceof HTMLButtonElement && focused.disabled)
      ) {
        firstAction.focus()
      }
      return
    }
    if (!hadPendingPathRef.current) return
    hadPendingPathRef.current = false
    fileIdentityRef.current?.focus()
  }, [pendingPath, saving])

  useEffect(() => {
    let active = true
    // Bound once so the watch that was started is the one released, whatever the bridge looks
    // like by the time the node unmounts.
    const api = window.fileViewApi
    setResult(null)
    setEdit(UNEDITED)
    setSaveFailure(null)
    setPendingPath(null)
    void read()
    void api.watch(path)
    const identity = fileViewPathIdentity(path)
    const stop = api.onChange((changed) => {
      if (active && fileViewPathIdentity(changed) === identity) void read()
    })
    return () => {
      active = false
      readGenerationRef.current += 1
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

  const save = useCallback(async (): Promise<SaveOutcome> => {
    const state = editRef.current
    // One write at a time: a second Ctrl+S mid-flight would carry the same base and be refused as
    // a conflict against the node's own save.
    if (savingRef.current || state.draft === null || state.baseMtime === null || state.conflict) return 'failed'
    savingRef.current = true
    setSaving(true)
    const written = await window.fileViewApi
      .write({ path, content: state.draft, baseMtime: state.baseMtime })
      .catch((error: unknown): FileWriteResult => ({
        ok: false,
        reason: 'unwritable',
        message: (error as Error).message
      }))
    savingRef.current = false
    setSaving(false)
    if (!written.ok) {
      if (written.reason === 'conflict' || written.reason === 'not-found') {
        // Disk moved on: resolved like a watcher-raised conflict, with a re-read to show what is there.
        setEdit(editStateAfterRefusedSave)
        void read()
      } else {
        setSaveFailure(written)
      }
      return 'failed'
    }
    const saved = state.draft
    setSaveFailure(null)
    setResult((current) =>
      current?.ok ? { ...current, content: saved, mtime: written.mtime, size: written.size } : current
    )
    setEdit((current) => editStateAfterSave(written.mtime, saved, current.draft))
    // A draft can still move while an asynchronous write is in flight. That newer text remains
    // dirty and must get its own save before a file change may hide it.
    return editRef.current.draft === saved ? 'saved' : 'still-dirty'
  }, [path, read])

  /** Back to the file as it is on disk; also how a conflict is resolved in disk's favour. */
  const discard = (): void => {
    setEdit(editStateAfterRead(UNEDITED, resultRef.current ?? NOTHING_ON_DISK))
    setSaveFailure(null)
  }

  /** The draft wins the conflict: rebased on disk so the next save is accepted, still unsaved. */
  const keepDraft = (): void => {
    setEdit((state) => keepDraftOverDisk(state, resultRef.current ?? NOTHING_ON_DISK))
    setSaveFailure(null)
  }

  // The draft outranks disk, including a disk that has nothing to show any more.
  const shownContent = edit.draft ?? (result?.ok ? result.content : '')
  const canSave = dirty && !edit.conflict && !saving && editability.editable
  /*
   * Markdown parsers read a frontmatter block as prose, which collapses the whole record into one
   * run-on paragraph. The rendered view lifts it out and shows it as the metadata table a reader
   * expects, leaving only the body to the Markdown pipeline.
   */
  const frontmatter = mode === 'rendered' ? frontmatterForDisplay(shownContent) : undefined

  const requestFilePath = useCallback(async (): Promise<void> => {
    const nextPath = await data.onRequestFilePath(id)
    if (!nextPath || fileViewPathIdentity(nextPath) === fileViewPathIdentity(path)) return
    if (isDirty(editRef.current)) setPendingPath(nextPath)
    else data.onPathChange(id, nextPath)
  }, [data, id, path])

  const discardAndSwitch = (): void => {
    if (!pendingPath) return
    const nextPath = pendingPath
    setPendingPath(null)
    setEdit(editStateAfterRead(UNEDITED, resultRef.current ?? NOTHING_ON_DISK))
    setSaveFailure(null)
    data.onPathChange(id, nextPath)
  }

  const saveAndSwitch = async (): Promise<void> => {
    if (!pendingPath) return
    const nextPath = pendingPath
    // The picker may have opened while an ordinary Save was already in flight. If that save has
    // since cleared the draft, there is nothing left to write before honoring the selected path.
    if (!dirty) {
      setPendingPath(null)
      data.onPathChange(id, nextPath)
      return
    }
    const outcome = await save()
    if (outcome === 'still-dirty') return
    setPendingPath(null)
    if (outcome === 'saved') data.onPathChange(id, nextPath)
  }

  const trapPendingFileChangeFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const dialog = pendingDialogRef.current
    if (!dialog) return
    const focusable = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }

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
        <button
          ref={fileIdentityRef}
          type={'button'}
          className={'file-node-identity nodrag'}
          aria-label={'Change displayed file'}
          title={path}
          onMouseDown={stopDrag}
          onClick={() => void requestFilePath()}
        >
          <strong>
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
        </button>
        <span className="file-node-header-spacer" aria-hidden="true" />
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

      {findBar.open && mode === 'rendered' && (
        <FindBar
          containerRef={proseRef}
          contentKey={shownContent}
          openSignal={findBar.signal}
          label={`Find in ${fileNodeName(path)}`}
          onClose={closeFindBar}
        />
      )}

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
            {result?.ok && !result.binary && (
              <details className="file-node-conflict-disk">
                <summary>What is on disk now</summary>
                <pre>{result.content}</pre>
              </details>
            )}
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
              <div className="markdown-body file-node-prose" ref={proseRef}>
                {frontmatter && frontmatter.fields.length > 0 && (
                  <div className="markdown-table-scroll markdown-frontmatter">
                    <table>
                      <tbody>
                        {frontmatter.fields.map((field, index) => (
                          <tr key={`${field.key}-${index}`}>
                            <th scope="row">{field.key}</th>
                            <td>{field.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
                  {frontmatter ? frontmatter.body : shownContent}
                </ReactMarkdown>
              </div>
            ) : (
              <CodeEditor
                value={shownContent}
                path={path}
                readOnly={!editability.editable && !dirty}
                onChange={onEdit}
                onSave={() => void save()}
                searchSignal={editorSearchSignal}
              />
            )}
          </>
        ) : null}
      </div>
      {pendingPath &&
        createPortal(
          <div
            className={'worktree-dialog-overlay'}
            role={'dialog'}
            aria-modal={true}
            aria-labelledby={pendingFileChangeTitleId}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                if (!saving) setPendingPath(null)
                return
              }
              trapPendingFileChangeFocus(event)
            }}
          >
            <div ref={pendingDialogRef} className={'worktree-dialog'} tabIndex={-1}>
              <strong id={pendingFileChangeTitleId}>Unsaved changes</strong>
              <p>Choose what happens to the pending edits before displaying {fileNodeName(pendingPath)}.</p>
              <div className={'worktree-dialog-actions'}>
                <button type={'button'} disabled={saving} onClick={() => setPendingPath(null)}>
                  Abort
                </button>
                <button type={'button'} className={'danger'} disabled={saving} onClick={discardAndSwitch}>
                  Discard and switch
                </button>
                <button
                  type={'button'}
                  className={'primary'}
                  disabled={saving || (dirty && !canSave)}
                  onClick={() => void saveAndSwitch()}
                >
                  {saving ? 'Saving…' : dirty ? 'Save and switch' : 'Switch'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </article>
  )
}
