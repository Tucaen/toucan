import type {
  FirstMateExternalProject,
  FirstMateProjectRegistration,
  FirstMateProjectSelection
} from '../../shared/firstmate'
import type { AgentProvider } from '../../shared/agent'
import {
  firstMateTaskContextMetadata,
  type FirstMateTaskContext
} from '../../shared/firstmate-task-context'
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

function registrationLines(registration?: FirstMateProjectRegistration): string[] {
  const project = registration?.project
  if (!project) {
    return [
      `- FirstMate registration: unavailable${registration?.message ? ` (${registration.message})` : ''}`,
      'Confirm this project\'s path and delivery posture with the captain before changing any state in it.'
    ]
  }
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
  registration?: FirstMateProjectRegistration
): string {
  return [
    'ADE project assignment (application context):',
    `- id: ${JSON.stringify(target.projectId)}`,
    `- name: ${JSON.stringify(target.name)}`,
    `- path: ${JSON.stringify(target.wslPath)}`,
    `- Windows path: ${JSON.stringify(target.windowsPath)}`,
    ...registrationLines(registration),
    'This is the project selected in ADE\'s left sidebar when the captain sent the request below.',
    'It is the project for this request and for every crew task it creates, even if the sidebar selection changes later.',
    'The project may be outside FirstMate\'s private projects directory; use the absolute path above when inspecting or dispatching work.',
    'If the captain explicitly names a different project, follow that explicit choice.'
  ].join('\n')
}

export interface FirstMateRequestOptions {
  registration: FirstMateProjectRegistration
  provider: AgentProvider
  model?: string
}

function taskContext(options: FirstMateRequestOptions): FirstMateTaskContext | undefined {
  const project = options.registration.project
  if (!options.registration.ok || !project) return undefined
  return {
    version: 1,
    project: {
      adeProjectId: project.adeProjectId,
      registryName: project.registryName,
      windowsPath: project.windowsPath,
      wslPath: project.wslPath,
      mode: project.mode,
      autonomy: project.autonomy
    },
    validator: { agent: options.provider, model: options.model ?? 'default' }
  }
}

function taskContract(options: FirstMateRequestOptions): string {
  const context = taskContext(options)
  if (!context) {
    return [
      'ADE immutable task contract: unavailable because project registration failed.',
      'Do not create a brief, scout, or crew task until ADE can supply the durable task context.'
    ].join('\n')
  }
  const autonomy = context.project.autonomy ? 'on' : 'off'
  const spawnProfile = context.validator.model === 'default'
    ? `\`--harness ${context.validator.agent}\` and omit \`--model\` so FirstMate records its explicit default`
    : `\`--harness ${context.validator.agent} --model ${context.validator.model}\``
  return [
    'ADE immutable task contract (application-owned request context):',
    `- exact task metadata: \`${firstMateTaskContextMetadata(context)}\``,
    `- pinned validation provider/model: ${context.validator.agent}/${context.validator.model}`,
    'For every ship or scout created from this request:',
    `- pass the absolute checkout path to both \`fm-brief.sh\` and \`fm-spawn.sh\`: ${JSON.stringify(context.project.wslPath)}`,
    '- for a ship, resolve the concrete task delivery mode once at intake and pass `--mode` explicitly to both commands; '
      + `the standing posture is ${JSON.stringify(context.project.mode)} and must not be re-read from another project`,
    `- for a ship, pass \`--yolo ${autonomy}\`; autonomy cannot drift from this request's durable registration`,
    `- pass ${spawnProfile} to spawn; do not consult a later global provider selection`,
    '- immediately after spawn, append the exact task metadata carrier to that task\'s durable `state/<id>.meta`, '
      + 'preserving the spawn metadata and publishing the update atomically before treating dispatch as complete.',
    'The task metadata, not the current sidebar or global provider, is authoritative for supervision, recovery, validation, and completion reporting.'
  ].join('\n')
}

/**
 * What FirstMate receives for one request: the project assignment taken at submission, followed by
 * the captain's message unchanged.
 */
export function firstMateRequest(
  project: WorkspaceProject,
  text: string,
  options: FirstMateRequestOptions
): string {
  return `${projectAssignment(firstMateProjectTarget(project), options.registration)}\n\n${taskContract(options)}\n\n${text}`
}
