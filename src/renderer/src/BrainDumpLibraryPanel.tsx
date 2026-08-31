import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  BrainDumpApi,
  BrainDumpCaptureConversation,
  BrainDumpCollection,
  BrainDumpOutcome
} from '../../shared/brain-dump'
import type { BrainDumpPanelState, WorkspaceProject } from '../../shared/terminal'
import {
  brainDumpPanelBounds,
  brainDumpPanelKeyAction,
  brainDumpPanelMode,
  brainDumpPanelWidthFromPointer,
  clampBrainDumpPanelWidth
} from './brain-dump-panel-layout'
import { searchBrainDumpTopics } from './brain-dump-topics'
import BrainDumpCapture from './BrainDumpCapture'
import BrainDumpCaptureStatus from './BrainDumpCaptureStatus'
import BrainDumpLifecycleDialog from './BrainDumpLifecycleDialog'
import BrainDumpReader from './BrainDumpReader'
import BrainDumpTopicList from './BrainDumpTopicList'
import { useBrainDumpLibrary } from './use-brain-dump-library'

/**
 * The docked library. It renders the interfaces the layout module and the library hook already
 * decided; what it genuinely owns is the panel's own interaction surface - which column a narrow
 * panel shows, which dismissible layer Escape closes first, where focus returns from a dialog, and
 * the scroll positions a close/reopen must not lose. It stays mounted once opened, so reopening is
 * the same panel rather than a fresh one.
 */

/** How far one arrow press moves the resize separator, for resizing without a pointer. */
const KEYBOARD_RESIZE_STEP = 24

export interface BrainDumpLibraryPanelProps {
  /** Everything about the panel the workspace persists: open state, width, and the capture draft. */
  panel: BrainDumpPanelState
  workspaceWidth: number
  projects: readonly WorkspaceProject[]
  /** The project a fresh draft is filed under, unless the user picks another. */
  activeProjectPath?: string
  api: BrainDumpApi
  /** Today as `YYYY-MM-DD`, so relative dates in rows stay testable. */
  today: string
  onPanelChange(patch: Partial<BrainDumpPanelState>): void
  onOpenSessionOnCanvas(conversation: BrainDumpCaptureConversation): void
}

type CaptureTray = { open: boolean; microphone: boolean }

export default function BrainDumpLibraryPanel(props: BrainDumpLibraryPanelProps): JSX.Element {
  const { panel, projects } = props
  const { open, width } = panel
  const headingId = useId()
  const searchId = useId()
  const [tray, setTray] = useState<CaptureTray>({ open: false, microphone: false })
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | undefined>(undefined)
  const [draftTouched, setDraftTouched] = useState(false)
  /** In a narrow panel the list and reader take turns; selection survives the switch either way. */
  const [narrowView, setNarrowView] = useState<'list' | 'reader'>('list')
  const [reopened, setReopened] = useState<string | null>(null)
  const [resizing, setResizing] = useState(false)
  const [draftFocusSignal, setDraftFocusSignal] = useState(0)
  /** The provider a running capture was submitted with, promoted to the preference only on success. */
  const submittedProvider = useRef(panel.provider ?? 'codex')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  /** Whatever opened the archive dialog, so closing it returns focus exactly there. */
  const archiveInvoker = useRef<HTMLElement | null>(null)
  const scrollMemory = useRef<Record<BrainDumpCollection, { list: number; reader: number }>>({
    active: { list: 0, reader: 0 },
    archived: { list: 0, reader: 0 }
  })

  const onPanelChange = props.onPanelChange
  const clearDraft = useCallback(() => {
    onPanelChange({ draft: '', draftProjectPath: undefined })
    setDraftTouched(false)
  }, [onPanelChange])

  // A capture only counts as successful once the library has been re-read, which is also the only
  // moment a provider has earned the right to become the remembered preference.
  const onCaptureFiled = useCallback(() => {
    clearDraft()
    onPanelChange({ provider: submittedProvider.current })
  }, [clearDraft, onPanelChange])

  const library = useBrainDumpLibrary({ api: props.api, onCaptureFiled })
  const { current, collection } = library
  const mode = brainDumpPanelMode(width)
  const visible = searchBrainDumpTopics(current.topics, current.query, projects)
  const selected = visible.find((topic) => topic.slug === current.selectedSlug)
  const jobActive = library.capture?.status === 'working'
  const showReader = mode === 'wide' || (narrowView === 'reader' && !!selected)
  const showList = mode === 'wide' || !showReader

  // A close/reopen is the same panel, not a new one: the browser drops scroll offsets while the
  // panel is display:none, and a narrow panel unmounts whichever column it is not showing, so both
  // offsets are remembered here and re-applied whenever their column comes back.
  useEffect(() => {
    if (!open) return
    const remembered = scrollMemory.current[collection]
    if (listRef.current) listRef.current.scrollTop = remembered.list
    if (readerRef.current) readerRef.current.scrollTop = remembered.reader
  }, [collection, open, showList, showReader])

  // Ctrl+K belongs to the panel, not the workspace: it only means "search brain dumps" while this
  // panel is open, and it must never pull the caret out of a field the user is already typing in.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editingText =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || !!target?.isContentEditable
      if (brainDumpPanelKeyAction(event, { panelOpen: true, editingText }) !== 'focus-search') return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const rememberScroll = (): void => {
    scrollMemory.current[collection] = {
      list: listRef.current?.scrollTop ?? scrollMemory.current[collection].list,
      reader: readerRef.current?.scrollTop ?? scrollMemory.current[collection].reader
    }
  }

  const closePanel = (): void => {
    rememberScroll()
    onPanelChange({ open: false })
  }

  const draftProject = useMemo(
    () => (draftTouched ? panel.draftProjectPath : (panel.draftProjectPath ?? props.activeProjectPath)),
    [draftTouched, panel.draftProjectPath, props.activeProjectPath]
  )

  const openTray = (microphone: boolean): void => {
    setStartError(undefined)
    setTray({ open: true, microphone })
  }

  const submitCapture = async (): Promise<void> => {
    setStartError(undefined)
    const provider = panel.provider ?? 'codex'
    submittedProvider.current = provider
    const result = await library.startCapture({
      content: panel.draft ?? '',
      provider,
      ...(draftProject ? { projectPath: draftProject } : {})
    })
    if (!result.ok) setStartError(result.message)
  }

  /** Escape peels one layer at a time; a non-empty draft never disappears with the tray. */
  const dismissTopLayer = (): boolean => {
    if (archiveTarget) {
      setArchiveTarget(null)
      archiveInvoker.current?.focus()
      return true
    }
    if (tray.open) {
      setTray({ open: false, microphone: false })
      return true
    }
    if (open) {
      closePanel()
      return true
    }
    return false
  }

  const bounds = brainDumpPanelBounds(props.workspaceWidth)
  const captureTooltip = (idle: string): string =>
    jobActive ? 'A brain dump is being organized; capture is available again when it finishes' : idle

  return (
    <aside
      className="brain-dump-panel"
      data-mode={mode}
      data-resizing={resizing ? 'true' : undefined}
      hidden={!open}
      style={{ width, minWidth: width }}
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        if (dismissTopLayer()) event.stopPropagation()
      }}
    >
      <div
        className="brain-dump-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the brain-dump panel"
        aria-valuenow={width}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        tabIndex={0}
        onKeyDown={(event) => {
          const delta =
            event.key === 'ArrowLeft' ? KEYBOARD_RESIZE_STEP : event.key === 'ArrowRight' ? -KEYBOARD_RESIZE_STEP : 0
          if (!delta) return
          event.preventDefault()
          onPanelChange({ width: clampBrainDumpPanelWidth(width + delta, props.workspaceWidth) })
        }}
        onPointerDown={(event) => {
          const panelRight = event.currentTarget.parentElement?.getBoundingClientRect().right ?? 0
          event.currentTarget.setPointerCapture(event.pointerId)
          // A drag must track the pointer exactly, so the docking transition is suppressed for it.
          setResizing(true)
          const move = (pointer: PointerEvent): void => {
            onPanelChange({
              width: brainDumpPanelWidthFromPointer(pointer.clientX, panelRight, props.workspaceWidth)
            })
          }
          const release = (): void => {
            setResizing(false)
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', release)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', release)
        }}
      />

      <header className="brain-dump-panel-header">
        <div className="brain-dump-panel-identity">
          <span className="brain-dump-eyebrow">Personal knowledge</span>
          <h2 id={headingId}>Brain dumps</h2>
        </div>
        <div className="brain-dump-panel-controls">
          <button
            type="button"
            className="brain-dump-capture-button"
            aria-label="Write a brain dump"
            disabled={jobActive}
            title={captureTooltip('Write a brain dump — review it, then let the brain-dump skill organize it')}
            onClick={() => openTray(false)}
          >
            <span aria-hidden="true">✎</span>
          </button>
          <button
            type="button"
            className="brain-dump-capture-button"
            aria-label="Record a brain dump with the microphone"
            disabled={jobActive}
            title={captureTooltip(
              'Record a brain dump — review the transcript before the brain-dump skill organizes it'
            )}
            onClick={() => openTray(true)}
          >
            <span aria-hidden="true">🎙</span>
          </button>
          <button
            type="button"
            className="brain-dump-close"
            aria-label="Close the brain-dump library"
            onClick={closePanel}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="brain-dump-panel-filters">
        <label className="brain-dump-search" htmlFor={searchId}>
          Search brain dumps
        </label>
        <input
          id={searchId}
          ref={searchRef}
          type="search"
          value={current.query}
          placeholder="Search titles, text, and projects"
          onChange={(event) => library.setQuery(event.target.value)}
        />
        <div className="brain-dump-tabs" role="tablist" aria-label="Topic collection">
          {(['active', 'archived'] as const).map((candidate) => {
            const state = candidate === 'active' ? library.active : library.archived
            const counted = state.status === 'ready'
            return (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={collection === candidate}
                title={counted ? undefined : 'Open this collection to count its topics'}
                onClick={() => {
                  rememberScroll()
                  library.selectCollection(candidate)
                  setNarrowView('list')
                }}
              >
                {candidate === 'active' ? 'Active' : 'Archived'}
                <span className="brain-dump-tab-count">{counted ? state.topics.length : '—'}</span>
              </button>
            )
          })}
        </div>
        {reopened && (
          <button
            type="button"
            className="brain-dump-followup"
            onClick={() => {
              void library.openReference(reopened)
              setNarrowView('reader')
              setReopened(null)
            }}
          >
            View in Active
          </button>
        )}
      </div>

      {library.capture && (
        <BrainDumpCaptureStatus
          capture={library.capture}
          onCancel={library.cancelCapture}
          onRetry={() => void submitCapture()}
          onEditDraft={() => {
            setTray({ open: true, microphone: false })
            setDraftFocusSignal((current) => current + 1)
          }}
          onDismiss={library.dismissCapture}
          onOpenSessionOnCanvas={(conversation) => {
            library.dismissCapture()
            props.onOpenSessionOnCanvas(conversation)
          }}
        />
      )}

      <div className="brain-dump-panel-body" data-showing={showReader && !showList ? 'reader' : 'list'}>
        {showList && (
          <div className="brain-dump-list-column">
            {current.status === 'loading' && <p className="brain-dump-state">Reading the brain-dump library…</p>}
            {current.status === 'error' && (
              <p className="brain-dump-state" role="alert">
                {current.error}
                <button type="button" onClick={() => void library.refresh(collection)}>
                  Try again
                </button>
              </p>
            )}
            {current.status === 'ready' && visible.length === 0 && (
              <p className="brain-dump-state">
                {current.topics.length === 0
                  ? collection === 'active'
                    ? 'No brain dumps yet. Use the pen or microphone to capture one.'
                    : 'Nothing has been archived yet.'
                  : 'No topic matches this search.'}
                {current.topics.length > 0 && (
                  <button type="button" onClick={() => library.setQuery('')}>
                    Clear search
                  </button>
                )}
              </p>
            )}
            {visible.length > 0 && (
              <BrainDumpTopicList
                topics={visible}
                projects={projects}
                today={props.today}
                selectedSlug={current.selectedSlug}
                labelledBy={headingId}
                listRef={listRef}
                onSelect={(slug) => {
                  rememberScroll()
                  library.selectTopic(slug)
                  setNarrowView('reader')
                }}
              />
            )}
            {current.diagnostics.length > 0 && (
              <div className="brain-dump-diagnostics" role="status">
                <strong>{current.diagnostics.length} topic file(s) could not be read</strong>
                <ul>
                  {current.diagnostics.map((diagnostic) => (
                    <li key={diagnostic.path}>
                      <code>{diagnostic.path}</code> — {diagnostic.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {showReader && (
          <div className="brain-dump-reader-column">
            {selected ? (
              <BrainDumpReader
                topic={selected}
                projects={projects}
                today={props.today}
                readerRef={readerRef}
                lifecyclePending={library.lifecycle.pending}
                lifecycleError={library.lifecycle.error}
                onBack={
                  mode === 'narrow'
                    ? () => {
                        rememberScroll()
                        setNarrowView('list')
                      }
                    : undefined
                }
                onArchive={() => {
                  library.clearLifecycleError()
                  archiveInvoker.current = document.activeElement as HTMLElement | null
                  setArchiveTarget(selected.slug)
                }}
                onReopen={() => {
                  const slug = selected.slug
                  void library.reopen(slug).then((ok) => {
                    if (ok) setReopened(slug)
                  })
                }}
                onOpenReference={(slug) => {
                  void library.openReference(slug).then((result) => {
                    if (result === 'opened') setNarrowView('reader')
                  })
                }}
                resolveReference={library.resolveReference}
              />
            ) : (
              <p className="brain-dump-state">Select a topic to read it.</p>
            )}
          </div>
        )}
      </div>

      {tray.open && (
        <BrainDumpCapture
          draft={panel.draft ?? ''}
          projectPath={draftProject}
          provider={panel.provider ?? 'codex'}
          projects={projects}
          microphone={tray.microphone}
          jobActive={!!jobActive}
          startError={startError}
          focusSignal={draftFocusSignal}
          onDraftChange={(draft) => onPanelChange({ draft })}
          onProjectChange={(projectPath) => {
            setDraftTouched(true)
            onPanelChange({ draftProjectPath: projectPath })
          }}
          onProviderChange={(provider) => onPanelChange({ provider })}
          onSubmit={() => void submitCapture()}
          onDiscard={clearDraft}
          onClose={() => setTray({ open: false, microphone: false })}
        />
      )}

      {archiveTarget && (
        <BrainDumpLifecycleDialog
          title={library.active.topics.find((topic) => topic.slug === archiveTarget)?.title ?? archiveTarget}
          pending={library.lifecycle.pending}
          error={library.lifecycle.error}
          onCancel={() => {
            setArchiveTarget(null)
            archiveInvoker.current?.focus()
          }}
          onArchive={(outcome: BrainDumpOutcome) => {
            void library.archive(archiveTarget, outcome).then((ok) => {
              if (ok) setArchiveTarget(null)
            })
          }}
        />
      )}

      {/* One polite region for every status this panel produces, so nothing steals focus. */}
      <div className="brain-dump-visually-hidden" role="status" aria-live="polite">
        {library.announcement}
      </div>
    </aside>
  )
}
