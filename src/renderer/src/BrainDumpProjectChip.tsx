import type { BrainDumpProjectIdentity } from './brain-dump-topics'

/**
 * A topic's project, shown the one way the library shows it: always as text, with colour only ever
 * reinforcing a name that is already readable. The absolute path is too long for a row, so it
 * reaches pointer users through the tooltip and everyone else through the description a row
 * references with `aria-describedby`.
 */
export function BrainDumpProjectChip({ project }: { project: BrainDumpProjectIdentity }): JSX.Element {
  return (
    <>
      <span
        className="brain-dump-project"
        data-unassigned={project.unassigned ? 'true' : undefined}
        title={project.path ?? 'This topic is not assigned to a project.'}
      >
        {project.color && (
          <span className="brain-dump-project-mark" style={{ background: project.color }} aria-hidden="true" />
        )}
        <span className="brain-dump-project-label">{project.label}</span>
      </span>
      {project.note && <span className="brain-dump-project-note">{project.note}</span>}
    </>
  )
}

/** The screen-reader-only long form of the same identity. */
export function brainDumpProjectDescription(project: BrainDumpProjectIdentity): string {
  if (project.unassigned) return 'Unassigned'
  return `Project path ${project.path}${project.note ? `. ${project.note}` : ''}`
}
