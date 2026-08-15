import type {
  FirstMateExternalProject,
  FirstMateProjectRegistration,
  FirstMateProjectSelection
} from '../../shared/firstmate'
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

/** The sidebar selection ADE hands the main process to validate and register at submission. */
export function firstMateProjectSelection(project: WorkspaceProject): FirstMateProjectSelection {
  return { projectId: project.id, name: project.name, path: project.path }
}

function initializationNote(project: FirstMateExternalProject): string {
  if (project.initialization === 'authorized') {
    return 'authorized by the captain in ADE for this checkout'
  }
  if (project.initialization === 'required') {
    return 'not run; this posture needs it, and ADE holds it until the captain authorizes it in ADE, '
      + 'so do not initialize, refresh, or reset this checkout on your own'
  }
  return 'not required for this posture'
}

function registrationLines(project: FirstMateExternalProject): string[] {
  return [
    `- project name: ${JSON.stringify(project.registryName)}`,
    `- registered delivery posture: ${JSON.stringify(project.mode)}`,
    `- autonomy (+yolo): ${project.autonomy ? 'on' : 'off'}`,
    `- origin: ${project.origin ? JSON.stringify(project.origin) : 'none; this checkout has no remote'}`,
    `- no-mistakes initialization: ${initializationNote(project)}`,
    'This is a durable external project recorded in ADE\'s own registration file in this private'
      + ' FirstMate home. It is not a clone in the managed projects directory and must never be cloned,'
      + ' copied, or symlinked there.',
    'ADE does not write your firstmate-private fleet registry: if this project needs an entry in'
      + ' data/projects.md, that is your own add intake, and the posture above is the standing default'
      + ' ADE resolved. An entry you record there for this path outranks it from then on.'
  ]
}

function projectAssignment(
  target: FirstMateProjectTarget,
  project: FirstMateExternalProject
): string {
  return [
    'ADE project assignment (application context):',
    `- id: ${JSON.stringify(target.projectId)}`,
    `- name: ${JSON.stringify(target.name)}`,
    `- path: ${JSON.stringify(target.wslPath)}`,
    `- Windows path: ${JSON.stringify(target.windowsPath)}`,
    ...registrationLines(project),
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
export function firstMateRequest(
  project: WorkspaceProject,
  text: string,
  registration: FirstMateProjectRegistration
): string {
  if (!registration.ok || !registration.project) {
    throw new Error(
      registration.message ?? `ADE could not resolve FirstMate project ${project.name} (${project.id}).`
    )
  }
  return `${projectAssignment(firstMateProjectTarget(project), registration.project)}\n\n${text}`
}
