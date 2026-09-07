import { useEffect, useMemo, useState } from 'react'
import { FileText } from 'lucide-react'
import type { WorkspaceFileIndex } from '../../shared/workspace-files'
import { fileMentionExclusionNote, rankFileMentions } from './file-mention-completion'
import { joinWorkspacePath } from './file-node'

export interface FilePickerDialogProps {
  projectName: string
  /** The checkout or worktree directory the listing is relative to. */
  root: string
  onCancel(): void
  onOpen(path: string): void
}

/**
 * The canvas's file picker. It reads the same git-aware index the composer's `@` mention
 * uses and ranks with the same rule, so a path found one way is found the other way too; only
 * files are offered, since a directory has nothing to show in a node.
 */
export default function FilePickerDialog({ projectName, root, onCancel, onOpen }: FilePickerDialogProps): JSX.Element {
  const [index, setIndex] = useState<WorkspaceFileIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)

  useEffect(() => {
    let active = true
    window.workspaceFilesApi
      .index(root)
      .then((next) => {
        if (active) setIndex(next)
      })
      .catch(() => {
        if (active) setError('The project files could not be listed.')
      })
    return () => {
      active = false
    }
  }, [root])

  const files = useMemo(() => (index?.entries ?? []).filter((entry) => !entry.directory), [index])
  const matches = useMemo(() => rankFileMentions(files, query.trim(), []), [files, query])
  const activeIndex = Math.min(highlight, Math.max(matches.length - 1, 0))
  const note = fileMentionExclusionNote(index)

  const open = (relativePath: string): void => onOpen(joinWorkspacePath(root, relativePath))

  return (
    <div
      className="worktree-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-picker-title"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="worktree-dialog file-picker-dialog">
        <strong id="file-picker-title">Choose a file from {projectName}</strong>
        <p>Markdown opens rendered; anything else opens as highlighted text. The node updates as the file changes.</p>
        <input
          className="file-picker-search"
          type="search"
          autoFocus
          placeholder="Type part of a path…"
          aria-label="Search files"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setHighlight(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setHighlight(Math.min(activeIndex + 1, Math.max(matches.length - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlight(Math.max(activeIndex - 1, 0))
            } else if (event.key === 'Enter' && matches[activeIndex]) {
              event.preventDefault()
              open(matches[activeIndex].path)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            }
          }}
        />

        {error && <p className="worktree-dialog-error">{error}</p>}

        <ul className="file-picker-list" role="listbox" aria-label="Files">
          {matches.map((entry, position) => (
            <li key={entry.path} role="option" aria-selected={position === activeIndex}>
              <button
                type="button"
                className="file-picker-row"
                data-active={position === activeIndex ? 'true' : undefined}
                onMouseEnter={() => setHighlight(position)}
                onClick={() => open(entry.path)}
              >
                <FileText aria-hidden="true" />
                <span>{entry.path}</span>
              </button>
            </li>
          ))}
        </ul>

        {index && matches.length === 0 && (
          <p className="conversation-history-empty">{query ? 'No file matches that.' : 'No files to show.'}</p>
        )}
        {!index && !error && <p className="conversation-history-empty">Listing files…</p>}
        {note && <p className="file-picker-note">{note}</p>}

        <div className="worktree-dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
