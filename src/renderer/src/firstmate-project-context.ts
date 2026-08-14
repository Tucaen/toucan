import type { WorkspaceProject } from '../../shared/terminal'

function firstMatePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const drivePath = /^([a-zA-Z]):\/(.*)$/.exec(normalized)
  if (!drivePath) return normalized
  return `/mnt/${drivePath[1].toLocaleLowerCase()}/${drivePath[2]}`
}

export function firstMateProjectContext(project: WorkspaceProject): string {
  return [
    'ADE project assignment (application context):',
    `- name: ${JSON.stringify(project.name)}`,
    `- path: ${JSON.stringify(firstMatePath(project.path))}`,
    `- Windows path: ${JSON.stringify(project.path)}`,
    'This is the project selected in ADE\'s left sidebar. Treat it as the default project for the captain\'s request below.',
    'The project may be outside FirstMate\'s private projects directory; use the absolute path above when inspecting or dispatching work.',
    'If the captain explicitly names a different project, follow that explicit choice.'
  ].join('\n')
}
