import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import type { WorkspaceProject } from '../../shared/terminal'
import { BRAIN_DUMP_UNASSIGNED_LABEL, brainDumpPathIdentity, type BrainDumpProjectIdentity } from './brain-dump-topics'
import { BrainDumpProjectChipContent } from './BrainDumpProjectChip'
import { usePortalMenuPosition } from './use-portal-menu-position'

/**
 * The project chip made correctable. A topic's project is a guess the capture skill made, so the
 * chip that reports it is also the control that fixes it - including the `Unassigned` one, which is
 * the case that most often needs fixing.
 *
 * The menu portals to `<body>` and is positioned in viewport coordinates for the same reason the
 * node pickers do it: the chip sits inside scrolling, overflow-clipping panel columns, where a
 * CSS-anchored menu would be cut off. Only the projects the workspace has registered are offered,
 * so a pick can never write a path Toucan cannot resolve back to a project.
 */

export interface BrainDumpProjectPickerProps {
  project: BrainDumpProjectIdentity
  projects: readonly WorkspaceProject[]
  /** Disabled while an assignment is in flight, so one topic cannot be reassigned twice at once. */
  pending: boolean
  error?: string
  /** The picked project, or `undefined` for Unassigned. Never fires for the current one. */
  onAssign(project: WorkspaceProject | undefined): void
  /** Clears a previous failure when the menu is opened again, so a retry starts clean. */
  onOpen?(): void
  /**
   * Any change opens the menu. It is how a chip clicked in the list column reaches the one picker
   * that lives in the reader, instead of the list having to grow an interactive control inside its
   * listbox rows.
   */
  openSignal?: number
}

export default function BrainDumpProjectPicker(props: BrainDumpProjectPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const position = usePortalMenuPosition(
    buttonRef,
    menuRef,
    open,
    { width: 220, height: 0 },
    { align: 'start' },
    props.projects
  )

  const { openSignal, onOpen } = props
  useEffect(() => {
    if (openSignal === undefined) return
    onOpen?.()
    setOpen(true)
    buttonRef.current?.focus()
  }, [onOpen, openSignal])

  const closeUnlessFocusStaysInside = (relatedTarget: EventTarget | null): void => {
    const next = relatedTarget as Node | null
    if (containerRef.current?.contains(next) || menuRef.current?.contains(next)) return
    setOpen(false)
  }

  /*
   * Which option is the current one. The identity comparison is the same one the library resolves
   * projects with, so a topic filed under a differently-cased or differently-separated spelling of
   * a registered path still marks that project rather than none of them.
   */
  const currentIdentity =
    props.project.unassigned || !props.project.path ? undefined : brainDumpPathIdentity(props.project.path)

  const option = (project: WorkspaceProject | undefined): JSX.Element => {
    const selected = (project ? brainDumpPathIdentity(project.path) : undefined) === currentIdentity
    return (
      <button
        key={project?.id ?? 'unassigned'}
        type="button"
        role="option"
        aria-selected={selected}
        data-selected={selected}
        onClick={() => {
          setOpen(false)
          if (!selected) props.onAssign(project)
        }}
      >
        <strong>
          {project?.color && (
            <span className="brain-dump-project-mark" style={{ background: project.color }} aria-hidden="true" />
          )}
          {project?.name ?? BRAIN_DUMP_UNASSIGNED_LABEL}
          {selected && <Check className="node-picker-selected-marker" aria-hidden="true" />}
        </strong>
        {project && <span>{project.path}</span>}
      </button>
    )
  }

  const menu = open && (
    <div
      ref={menuRef}
      className="node-picker-menu brain-dump-project-menu"
      role="listbox"
      aria-label="File this topic under a project"
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
      onBlur={(event) => closeUnlessFocusStaysInside(event.relatedTarget)}
    >
      <small>Project</small>
      {option(undefined)}
      {props.projects.map((project) => option(project))}
    </div>
  )

  return (
    <span
      ref={containerRef}
      onBlur={(event) => closeUnlessFocusStaysInside(event.relatedTarget)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus()
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="brain-dump-project brain-dump-project-trigger"
        data-unassigned={props.project.unassigned ? 'true' : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={props.pending}
        title={
          props.project.unassigned
            ? 'Not assigned to a project — pick the one it belongs to'
            : `${props.project.path} — pick another project`
        }
        onClick={() => {
          if (!open) props.onOpen?.()
          setOpen((current) => !current)
        }}
      >
        <BrainDumpProjectChipContent project={props.project} />
        <ChevronDown aria-hidden="true" />
      </button>
      {props.project.note && <span className="brain-dump-project-note">{props.project.note}</span>}
      {props.error && (
        <span className="brain-dump-project-error" role="alert">
          {props.error}
        </span>
      )}
      {menu && createPortal(menu, document.body)}
    </span>
  )
}
