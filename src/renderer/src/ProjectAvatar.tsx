import type { CSSProperties, ReactNode } from 'react'
import type { WorkspaceProject } from '../../shared/workspace'

/**
 * The one project chip: the custom avatar image when the project has one, the project's first
 * letter otherwise, in the project's colour. The sidebar row and the settings dialog's preview
 * both render this, so what an avatar looks like - and its letter fallback - is decided once.
 * `children` is for overlays the chip carries (the sidebar's unread badge).
 */
export function ProjectAvatar({
  project,
  avatarUrl,
  className,
  imageAlt = '',
  children
}: {
  project: Pick<WorkspaceProject, 'name' | 'color'>
  avatarUrl: string | null
  className?: string
  imageAlt?: string
  children?: ReactNode
}): JSX.Element {
  return (
    <span
      className={className ? `project-avatar ${className}` : 'project-avatar'}
      style={{ '--project-color': project.color } as CSSProperties}
    >
      {avatarUrl ? (
        <img className="project-avatar-image" src={avatarUrl} alt={imageAlt} draggable={false} />
      ) : (
        project.name.slice(0, 1).toUpperCase()
      )}
      {children}
    </span>
  )
}
