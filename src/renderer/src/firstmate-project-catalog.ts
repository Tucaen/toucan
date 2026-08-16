import type { AgentProvider } from '../../shared/agent'
import type {
  FirstMateProjectCatalog,
  FirstMateProjectCatalogEntry,
  FirstMateProjectRegistration,
  FirstMateProjectSelection
} from '../../shared/firstmate'
import {
  firstMateTaskContextMetadata,
  type FirstMateTaskContext
} from '../../shared/firstmate-task-context'
import type { WorkspaceProject } from '../../shared/terminal'

/**
 * The active sidebar project shown as context for the next request, never as a binding. The renderer
 * never derives a WSL path; a registered project's `wslPath` comes from the main process instead.
 */
export interface FirstMateProjectHint {
  projectId: string
  name: string
  windowsPath: string
}

export interface FirstMateRequestProject {
  selection: WorkspaceProject
  registration: FirstMateProjectRegistration
}

export interface FirstMateRequestOptions {
  provider: AgentProvider
  model?: string
}

export function firstMateProjectHint(project: WorkspaceProject): FirstMateProjectHint {
  return Object.freeze({
    projectId: project.id,
    name: project.name,
    windowsPath: project.path
  })
}

/** The sidebar project ADE hands the main process to validate and register for the catalog. */
export function firstMateProjectSelection(project: WorkspaceProject): FirstMateProjectSelection {
  return { projectId: project.id, name: project.name, path: project.path }
}

function taskContext(
  project: NonNullable<FirstMateProjectRegistration['project']>,
  validator: FirstMateProjectCatalog['validator']
): FirstMateTaskContext {
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
    validator
  }
}

function catalogEntry(
  registration: FirstMateProjectRegistration,
  validator: FirstMateProjectCatalog['validator']
): FirstMateProjectCatalogEntry | undefined {
  const project = registration.project
  if (!registration.ok || !project) return undefined
  return {
    adeProjectId: project.adeProjectId,
    registryName: project.registryName,
    displayName: project.displayName,
    canonicalPaths: {
      windows: project.windowsPath,
      wsl: project.wslPath
    },
    effectiveDeliveryPosture: project.mode,
    autonomyPolicy: project.autonomy ? 'on' : 'off',
    originClassification: project.originClassification,
    ...(project.originClassification !== 'unsupported-inert' && project.origin ? { origin: project.origin } : {}),
    initialization: project.initialization,
    taskContextMetadata: firstMateTaskContextMetadata(taskContext(project, validator))
  }
}

export function firstMateProjectCatalog(
  requestProjects: FirstMateRequestProject[],
  activeProjectId: string,
  options: FirstMateRequestOptions
): FirstMateProjectCatalog {
  const validator = { agent: options.provider, model: options.model ?? 'default' }
  const projects: FirstMateProjectCatalogEntry[] = []
  const unavailableProjects: FirstMateProjectCatalog['unavailableProjects'] = []
  for (const { selection, registration } of requestProjects) {
    const entry = catalogEntry(registration, validator)
    if (entry && entry.adeProjectId === selection.id) {
      projects.push(entry)
      continue
    }
    unavailableProjects.push({
      adeProjectId: selection.id,
      displayName: selection.name,
      reason: entry
        ? `Registration identity ${entry.adeProjectId} does not match ADE project ${selection.id}.`
        : registration.message ?? 'ADE could not validate this project for FirstMate.'
    })
  }
  return {
    version: 1,
    activeProjectHint: { adeProjectId: activeProjectId, role: 'hint-only' },
    validator,
    projects,
    unavailableProjects
  }
}

function dispatchContract(): string {
  return [
    'The activeProjectHint is a hint only. It never prevents selecting another projects entry.',
    'You remain the author of semantic ship and scout briefs and the scheduler of crew work. Use the existing managed brief, scheduler, worktree, and spawn machinery; ADE is not a competing scheduler.',
    'Before creating any brief or launching any crew, resolve every intended task to exactly one catalog project. If any match is missing or ambiguous, ask the captain for clarification and launch no crew.',
    'For every resolved ship or scout task:',
    '- use that entry\'s canonicalPaths.wsl as the absolute checkout path for both `fm-brief.sh` and `fm-spawn.sh`;',
    '- use only managed `fm-spawn.sh`, whose Git guard proves the allocated directory is a disposable worktree rather than the primary checkout;',
    '- for a ship, resolve the concrete task delivery mode once at semantic intake from that entry\'s effectiveDeliveryPosture, then pass the resolved `--mode` explicitly to both commands; `no-mistakes-prod-only` is conditional policy, not a flat task mode;',
    '- for a ship, pass that entry\'s autonomyPolicy as `--yolo` to both commands;',
    '- for a scout, pass `--scout` to both commands and do not pass ship-only mode or autonomy flags;',
    '- pass the catalog validator agent as `--harness`; omit `--model` when its value is `default`, otherwise pass it explicitly;',
    '- after spawn, append only that selected entry\'s exact taskContextMetadata to durable `state/<id>.meta`, preserving existing metadata and publishing atomically before dispatch completes.',
    'That carrier, not this request\'s active hint or any later sidebar/provider selection, is authoritative for supervision, recovery, validation, and completion reporting.'
  ].join('\n')
}

/** Gives the persistent FirstMate captain a project-catalog snapshot followed by the user's message unchanged. */
export function firstMateRequest(
  requestProjects: FirstMateRequestProject[],
  activeProjectId: string,
  text: string,
  options: FirstMateRequestOptions
): string {
  const catalog = firstMateProjectCatalog(requestProjects, activeProjectId, options)
  return [
    'ADE project catalog (machine-readable request context):',
    '<ade-project-catalog>',
    JSON.stringify(catalog),
    '</ade-project-catalog>',
    '',
    dispatchContract(),
    '',
    text
  ].join('\n')
}
