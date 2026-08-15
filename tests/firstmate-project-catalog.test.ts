import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type {
  FirstMateProjectCatalog,
  FirstMateProjectRegistration
} from '../src/shared/firstmate'
import { firstMateTaskContextFromMetadata } from '../src/shared/firstmate-task-context'
import type { WorkspaceProject } from '../src/shared/terminal'
import {
  firstMateProjectHint,
  firstMateRequest,
  type FirstMateRequestProject
} from '../src/renderer/src/firstmate-project-catalog'
import { firstMateCanonicalWindowsPath, firstMateWslPath } from '../src/main/firstmate-paths'
import { firstMateCatalogFromRequest } from './firstmate-catalog-test-helpers'

/** The registered WSL path a project carries, as the main process derives it for the catalog. */
function registeredWslPath(windowsPath: string): string {
  return firstMateWslPath(firstMateCanonicalWindowsPath(windowsPath)!)
}

const alpha: WorkspaceProject = {
  id: 'alpha', name: 'Api', path: 'D:\\Development\\alpha\\api', color: '#71a9ff'
}
const beta: WorkspaceProject = {
  id: 'beta', name: 'Web', path: 'D:\\Development\\beta\\web', color: '#f0a'
}
const local: WorkspaceProject = {
  id: 'local', name: 'Scratch', path: 'E:\\Scratch\\local', color: '#0fa'
}

function registrationFor(
  project: WorkspaceProject,
  options: { origin?: string; mode?: 'no-mistakes-prod-only' | 'local-only'; autonomy?: boolean } = {}
): FirstMateProjectRegistration {
  return {
    ok: true,
    project: {
      adeProjectId: project.id,
      registryName: `${project.name.toLocaleLowerCase()}-${project.id}`,
      displayName: project.name,
      windowsPath: project.path,
      wslPath: registeredWslPath(project.path),
      ...(options.origin === undefined && options.mode === 'local-only'
        ? {}
        : { origin: options.origin ?? `git@github.com:acme/${project.id}.git` }),
      mode: options.mode ?? 'no-mistakes-prod-only',
      autonomy: options.autonomy ?? false,
      initialization: options.mode === 'local-only' ? 'not-required' : 'required',
      registeredAt: '2026-08-15'
    }
  }
}

function requestProject(
  project: WorkspaceProject,
  registration: FirstMateProjectRegistration = registrationFor(project)
): FirstMateRequestProject {
  return { selection: project, registration }
}

interface FakeCaptainDispatch {
  clarification?: string
  tasks: Array<{ projectId: string; metadata: string }>
}

/** Selects exactly as the captain is instructed to, without invoking a model or spawn machinery. */
function fakeCaptainSelect(catalog: FirstMateProjectCatalog, projectIds: string[]): FakeCaptainDispatch {
  const selected = projectIds.map((projectReference) => ({
    projectReference,
    matches: catalog.projects.filter((project) => (
      project.adeProjectId === projectReference
      || project.registryName === projectReference
      || project.displayName === projectReference
    ))
  }))
  const unresolved = selected.find(({ matches }) => matches.length !== 1)
  if (unresolved) {
    return {
      clarification: `Clarify ${unresolved.projectReference}: found ${unresolved.matches.length} catalog matches.`,
      tasks: []
    }
  }
  return {
    tasks: selected.map(({ projectReference, matches }) => ({
      projectId: matches[0]?.adeProjectId ?? projectReference,
      metadata: matches[0]!.taskContextMetadata
    }))
  }
}

test('delivers a machine-readable catalog with the active sidebar project marked as a hint', () => {
  const prompt = firstMateRequest(
    [requestProject(alpha), requestProject(beta)],
    beta.id,
    'Ship the API',
    { provider: 'claude', model: 'claude-sonnet-4-5' }
  )
  const catalog = firstMateCatalogFromRequest(prompt)

  assert.deepEqual(catalog.activeProjectHint, { adeProjectId: 'beta', role: 'hint-only' })
  assert.deepEqual(catalog.validator, { agent: 'claude', model: 'claude-sonnet-4-5' })
  assert.deepEqual(catalog.projects.map((project) => ({
    adeProjectId: project.adeProjectId,
    displayName: project.displayName,
    canonicalPaths: project.canonicalPaths,
    effectiveDeliveryPosture: project.effectiveDeliveryPosture,
    autonomyPolicy: project.autonomyPolicy,
    originClassification: project.originClassification
  })), [
    {
      adeProjectId: 'alpha',
      displayName: 'Api',
      canonicalPaths: { windows: 'D:\\Development\\alpha\\api', wsl: '/mnt/d/Development/alpha/api' },
      effectiveDeliveryPosture: 'no-mistakes-prod-only',
      autonomyPolicy: 'off',
      originClassification: 'remote-backed'
    },
    {
      adeProjectId: 'beta',
      displayName: 'Web',
      canonicalPaths: { windows: 'D:\\Development\\beta\\web', wsl: '/mnt/d/Development/beta/web' },
      effectiveDeliveryPosture: 'no-mistakes-prod-only',
      autonomyPolicy: 'off',
      originClassification: 'remote-backed'
    }
  ])
  assert.ok(prompt.endsWith('\n\nShip the API'), 'the captain message should remain verbatim')
  assert.match(prompt, /The activeProjectHint is a hint only/)
})

test('a fake captain can pin a non-active project at dispatch', () => {
  const prompt = firstMateRequest(
    [requestProject(alpha), requestProject(beta)],
    alpha.id,
    'Fix the web project',
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )

  const dispatch = fakeCaptainSelect(firstMateCatalogFromRequest(prompt), ['beta'])
  const context = firstMateTaskContextFromMetadata(dispatch.tasks[0]!.metadata)

  assert.equal(dispatch.clarification, undefined)
  assert.equal(context?.project.adeProjectId, 'beta')
  assert.equal(context?.project.windowsPath, beta.path)
  assert.deepEqual(context?.validator, { agent: 'codex', model: 'gpt-5.6-sol' })
})

test('a fake captain can pin separate projects for separate tasks from one request', () => {
  const catalog = firstMateCatalogFromRequest(firstMateRequest(
    [requestProject(alpha), requestProject(beta)],
    alpha.id,
    'Update the API and web app',
    { provider: 'codex' }
  ))

  const dispatch = fakeCaptainSelect(catalog, ['alpha', 'beta'])

  assert.deepEqual(
    dispatch.tasks.map((task) => firstMateTaskContextFromMetadata(task.metadata)?.project.adeProjectId),
    ['alpha', 'beta']
  )
  assert.notEqual(dispatch.tasks[0]!.metadata, dispatch.tasks[1]!.metadata)
})

test('a missing or ambiguous captain selection requests clarification and dispatches no task', () => {
  const sameNameBeta = { ...beta, name: 'Api' }
  const catalog = firstMateCatalogFromRequest(firstMateRequest(
    [requestProject(alpha), requestProject(sameNameBeta)],
    alpha.id,
    'Fix the service',
    { provider: 'codex' }
  ))

  const missing = fakeCaptainSelect(catalog, ['unknown'])
  const ambiguous = fakeCaptainSelect(catalog, ['Api'])

  assert.match(missing.clarification ?? '', /found 0 catalog matches/)
  assert.deepEqual(missing.tasks, [])
  assert.match(ambiguous.clarification ?? '', /found 2 catalog matches/)
  assert.deepEqual(ambiguous.tasks, [])
  assert.match(firstMateRequest(
    [requestProject(alpha), requestProject(sameNameBeta)],
    alpha.id,
    'Fix the service',
    { provider: 'codex' }
  ), /missing or ambiguous[\s\S]*?clarification and launch no crew/i)
})

test('classifies remote-backed and local-only projects without losing their delivery policy', () => {
  const catalog = firstMateCatalogFromRequest(firstMateRequest(
    [
      requestProject(alpha),
      requestProject(local, registrationFor(local, { mode: 'local-only', autonomy: true }))
    ],
    local.id,
    'Compare both projects',
    { provider: 'codex' }
  ))

  assert.deepEqual(catalog.projects.map((project) => ({
    id: project.adeProjectId,
    origin: project.originClassification,
    posture: project.effectiveDeliveryPosture,
    autonomy: project.autonomyPolicy
  })), [
    { id: 'alpha', origin: 'remote-backed', posture: 'no-mistakes-prod-only', autonomy: 'off' },
    { id: 'local', origin: 'local-only', posture: 'local-only', autonomy: 'on' }
  ])
})

test('unavailable projects remain machine-readable but cannot supply a dispatch context', () => {
  const catalog = firstMateCatalogFromRequest(firstMateRequest(
    [
      requestProject(alpha),
      requestProject(beta, {
        ok: false,
        message: 'The WSL checkout is unavailable.',
        failure: { kind: 'wsl', adeProjectId: 'beta' }
      })
    ],
    beta.id,
    'Fix beta',
    { provider: 'codex' }
  ))

  assert.deepEqual(catalog.projects.map((project) => project.adeProjectId), ['alpha'])
  assert.deepEqual(catalog.unavailableProjects, [{
    adeProjectId: 'beta',
    displayName: 'Web',
    reason: 'The WSL checkout is unavailable.'
  }])
  assert.deepEqual(fakeCaptainSelect(catalog, ['beta']).tasks, [])
})

test('changing the active sidebar hint after dispatch cannot retarget existing task metadata', () => {
  const request = firstMateRequest(
    [requestProject(alpha), requestProject(beta)],
    alpha.id,
    'Fix beta',
    { provider: 'codex' }
  )
  const dispatched = fakeCaptainSelect(firstMateCatalogFromRequest(request), ['beta']).tasks[0]!

  firstMateRequest(
    [requestProject(alpha), requestProject(beta)],
    beta.id,
    'A later request',
    { provider: 'claude', model: 'later-model' }
  )

  assert.equal(firstMateTaskContextFromMetadata(dispatched.metadata)?.project.adeProjectId, 'beta')
  assert.deepEqual(firstMateTaskContextFromMetadata(dispatched.metadata)?.validator, {
    agent: 'codex', model: 'default'
  })
})

test('snapshots a sidebar project path for display without deriving a WSL path', () => {
  const hint = firstMateProjectHint(alpha)

  assert.deepEqual({ ...hint }, {
    projectId: 'alpha',
    name: 'Api',
    windowsPath: 'D:\\Development\\alpha\\api'
  })
  assert.equal(
    'wslPath' in hint,
    false,
    'the renderer consumes a registered WSL path; it never derives one for the sidebar hint'
  )
  assert.ok(Object.isFrozen(hint))
})
