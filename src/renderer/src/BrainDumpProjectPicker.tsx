import { ChevronDown } from 'lucide-react'
import type { WorkspaceProject } from '../../shared/workspace'
import { BRAIN_DUMP_UNASSIGNED_LABEL, type BrainDumpProjectIdentity } from './brain-dump-topics'
import { pathIdentity } from '../../shared/paths'
import { BrainDumpProjectChipContent } from './BrainDumpProjectChip'
import { ListboxPicker, type ListboxPickerOption } from './ListboxPicker'

/**
 * The project chip made correctable. A topic's project is a guess the capture skill made, so the
 * chip that reports it is also the control that fixes it - including the `Unassigned` one, which is
 * the case that most often needs fixing.
 *
 * The popup is the shared `ListboxPicker` - portal, position and keyboard model included - and
 * only the projects the workspace has registered are offered, so a pick can never write a path
 * Toucan cannot resolve back to a project.
 */

const UNASSIGNED_ID = 'unassigned'

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
  /*
   * Which option is the current one. The identity comparison is the same one the library resolves
   * projects with, so a topic filed under a differently-cased or differently-separated spelling of
   * a registered path still marks that project rather than none of them.
   */
  const currentIdentity = props.project.unassigned || !props.project.path ? undefined : pathIdentity(props.project.path)

  const option = (project: WorkspaceProject | undefined): ListboxPickerOption => ({
    id: project?.id ?? UNASSIGNED_ID,
    selected: (project ? pathIdentity(project.path) : undefined) === currentIdentity,
    content: (
      <>
        {project?.color && (
          <span className="brain-dump-project-mark" style={{ background: project.color }} aria-hidden="true" />
        )}
        {project?.name ?? BRAIN_DUMP_UNASSIGNED_LABEL}
      </>
    ),
    description: project?.path
  })

  const options = [option(undefined), ...props.projects.map((project) => option(project))]

  return (
    <ListboxPicker
      options={options}
      heading="Project"
      menuAriaLabel="File this topic under a project"
      menuClassName="brain-dump-project-menu"
      menuWidth={220}
      align="start"
      container="span"
      trigger={{
        className: 'brain-dump-project brain-dump-project-trigger',
        disabled: props.pending,
        title: props.project.unassigned
          ? 'Not assigned to a project — pick the one it belongs to'
          : `${props.project.path} — pick another project`,
        data: { 'data-unassigned': props.project.unassigned ? 'true' : undefined },
        content: (
          <>
            <BrainDumpProjectChipContent project={props.project} />
            <ChevronDown aria-hidden="true" />
          </>
        )
      }}
      onOpen={props.onOpen}
      openSignal={props.openSignal}
      select={(optionId) => {
        if (options.find((candidate) => candidate.id === optionId)?.selected) return
        props.onAssign(props.projects.find((project) => project.id === optionId))
      }}
    >
      {props.project.note && <span className="brain-dump-project-note">{props.project.note}</span>}
      {props.error && (
        <span className="brain-dump-project-error" role="alert">
          {props.error}
        </span>
      )}
    </ListboxPicker>
  )
}
