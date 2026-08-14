import type { WorkspaceProject } from '../../shared/terminal'

/**
 * The project a FirstMate request belongs to. Snapshotted from the sidebar selection when the
 * captain submits, so a later selection can never retarget that request or the crew tasks it created.
 */
export interface FirstMateProjectTarget {
  projectId: string
  name: string
  windowsPath: string
  wslPath: string
}

function firstMatePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const drivePath = /^([a-zA-Z]):\/(.*)$/.exec(normalized)
  if (!drivePath) return normalized
  return `/mnt/${drivePath[1].toLocaleLowerCase()}/${drivePath[2]}`
}

export function firstMateProjectTarget(project: WorkspaceProject): FirstMateProjectTarget {
  return Object.freeze({
    projectId: project.id,
    name: project.name,
    windowsPath: project.path,
    wslPath: firstMatePath(project.path)
  })
}

function projectAssignment(target: FirstMateProjectTarget): string {
  return [
    'ADE project assignment (application context):',
    `- id: ${JSON.stringify(target.projectId)}`,
    `- name: ${JSON.stringify(target.name)}`,
    `- path: ${JSON.stringify(target.wslPath)}`,
    `- Windows path: ${JSON.stringify(target.windowsPath)}`,
    'This is the project selected in ADE\'s left sidebar when the captain sent the request below.',
    'It is the project for this request and for every crew task it creates, even if the sidebar selection changes later.',
    'The project may be outside FirstMate\'s private projects directory; use the absolute path above when inspecting or dispatching work.',
    'If the captain explicitly names a different project, follow that explicit choice.'
  ].join('\n')
}

/**
 * What FirstMate receives for one request: the project assignment taken at submission, followed by
 * the captain's message unchanged.
 */
export function firstMateRequest(project: WorkspaceProject, text: string): string {
  return `${projectAssignment(firstMateProjectTarget(project))}\n\n${text}`
}
