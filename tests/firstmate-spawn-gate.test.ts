import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { FirstMateTaskContext } from '../src/shared/firstmate-task-context'
import { firstMateTaskContextFromMetadata } from '../src/shared/firstmate-task-context'
import {
  firstMateSpawnContextProblem,
  type FirstMateSpawnGateProject,
  type FirstMateSpawnGateValidator
} from '../src/main/firstmate-spawn-gate'
import {
  firstMateProjectCatalog,
  firstMateRequest,
  type FirstMateRequestProject
} from '../src/renderer/src/firstmate-project-catalog'
import type { FirstMateProjectRegistration } from '../src/shared/firstmate'
import type { WorkspaceProject } from '../src/shared/terminal'
import { firstMateCanonicalWindowsPath, firstMateWslPath } from '../src/main/firstmate-paths'

const project: FirstMateSpawnGateProject = {
  adeProjectId: 'alpha',
  registryName: 'api-alpha',
  windowsPath: 'D:\\Development\\alpha\\api',
  wslPath: '/mnt/d/Development/alpha/api',
  mode: 'no-mistakes',
  autonomy: false
}

const validator: FirstMateSpawnGateValidator = { agent: 'codex', model: 'gpt-5.6-sol' }

const matchingContext: FirstMateTaskContext = {
  version: 1,
  project: {
    adeProjectId: 'alpha',
    registryName: 'api-alpha',
    windowsPath: 'D:\\Development\\alpha\\api',
    wslPath: '/mnt/d/Development/alpha/api',
    mode: 'no-mistakes',
    autonomy: false
  },
  validator: { agent: 'codex', model: 'gpt-5.6-sol' }
}

test('a matching context passes the spawn gate', () => {
  assert.equal(firstMateSpawnContextProblem(matchingContext, project, validator), undefined)
})

test('a mismatched project id refuses and names both values', () => {
  const drifted: FirstMateTaskContext = {
    ...matchingContext,
    project: { ...matchingContext.project, adeProjectId: 'beta' }
  }
  const problem = firstMateSpawnContextProblem(drifted, project, validator)
  assert.ok(problem)
  assert.match(problem, /beta/)
  assert.match(problem, /alpha/)
  assert.match(problem, /disagrees with authoritative/)
})

test('a mismatched registry name refuses and names both values', () => {
  const drifted: FirstMateTaskContext = {
    ...matchingContext,
    project: { ...matchingContext.project, registryName: 'web-beta' }
  }
  const problem = firstMateSpawnContextProblem(drifted, project, validator)
  assert.ok(problem)
  assert.match(problem, /web-beta/)
  assert.match(problem, /api-alpha/)
})

test('a mismatched Windows path refuses and names both values', () => {
  const drifted: FirstMateTaskContext = {
    ...matchingContext,
    project: { ...matchingContext.project, windowsPath: 'D:\\Other\\path' }
  }
  const problem = firstMateSpawnContextProblem(drifted, project, validator)
  assert.ok(problem)
  assert.match(problem, /Other/)
  assert.match(problem, /alpha/)
})

test('a mismatched WSL path refuses and names both values', () => {
  const drifted: FirstMateTaskContext = {
    ...matchingContext,
    project: { ...matchingContext.project, wslPath: '/mnt/d/Other/path' }
  }
  const problem = firstMateSpawnContextProblem(drifted, project, validator)
  assert.ok(problem)
  assert.match(problem, /Other/)
  assert.match(problem, /alpha/)
})

test('a mismatched delivery posture refuses and names both values', () => {
  const drifted: FirstMateTaskContext = {
    ...matchingContext,
    project: { ...matchingContext.project, mode: 'direct-PR' }
  }
  const problem = firstMateSpawnContextProblem(drifted, project, validator)
  assert.ok(problem)
  assert.match(problem, /direct-PR/)
  assert.match(problem, /no-mistakes/)
})

test('a mismatched autonomy authorization refuses and names both values', () => {
  const drifted: FirstMateTaskContext = {
    ...matchingContext,
    project: { ...matchingContext.project, autonomy: true }
  }
  const problem = firstMateSpawnContextProblem(drifted, project, validator)
  assert.ok(problem)
  assert.match(problem, /true/)
  assert.match(problem, /false/)
})

test('a mismatched provider refuses and names both values', () => {
  const drifted: FirstMateTaskContext = {
    ...matchingContext,
    validator: { agent: 'claude', model: 'gpt-5.6-sol' }
  }
  const problem = firstMateSpawnContextProblem(drifted, project, validator)
  assert.ok(problem)
  assert.match(problem, /claude/)
  assert.match(problem, /codex/)
})

test('a mismatched model refuses and names both values', () => {
  const drifted: FirstMateTaskContext = {
    ...matchingContext,
    validator: { agent: 'codex', model: 'gpt-4o' }
  }
  const problem = firstMateSpawnContextProblem(drifted, project, validator)
  assert.ok(problem)
  assert.match(problem, /gpt-4o/)
  assert.match(problem, /gpt-5\.6-sol/)
})

test('the dispatch contract requires spawn gate validation before fm-spawn.sh', () => {
  const prompt = firstMateRequest(
    [requestProject(alpha)],
    alpha.id,
    'Ship it',
    { provider: 'codex' }
  )
  assert.match(prompt, /ade-spawn-gate/, 'the contract must reference the managed ADE spawn gate')
  const gateIndex = prompt.indexOf('ade-spawn-gate')
  const spawnIndex = prompt.indexOf('fm-spawn.sh', gateIndex)
  assert.ok(
    gateIndex < spawnIndex,
    'the gate must appear before fm-spawn.sh in the contract so the captain calls it first'
  )
})

// --- Integration: catalog → captain selection → spawn gate ---

function registeredWslPath(windowsPath: string): string {
  return firstMateWslPath(firstMateCanonicalWindowsPath(windowsPath)!)
}

const alpha: WorkspaceProject = {
  id: 'alpha', name: 'Api', path: 'D:\\Development\\alpha\\api', color: '#71a9ff'
}
const beta: WorkspaceProject = {
  id: 'beta', name: 'Web', path: 'D:\\Development\\beta\\web', color: '#f0a'
}

function registrationFor(ws: WorkspaceProject): FirstMateProjectRegistration {
  return {
    ok: true,
    project: {
      adeProjectId: ws.id,
      registryName: `${ws.name.toLocaleLowerCase()}-${ws.id}`,
      displayName: ws.name,
      windowsPath: ws.path,
      wslPath: registeredWslPath(ws.path),
      origin: `git@github.com:acme/${ws.id}.git`,
      originClassification: 'remote-backed',
      mode: 'no-mistakes',
      autonomy: false,
      autonomyCeiling: false,
      postureSource: 'default',
      initialization: 'required',
      registeredAt: '2026-08-16'
    }
  }
}

function requestProject(ws: WorkspaceProject): FirstMateRequestProject {
  return { selection: ws, registration: registrationFor(ws) }
}

function fakeCaptainSelectOne(
  catalog: ReturnType<typeof firstMateProjectCatalog>,
  projectId: string
): string | undefined {
  const entry = catalog.projects.find((p) => p.adeProjectId === projectId)
  return entry?.taskContextMetadata
}

test('a dispatch matching the authoritative project record passes the spawn gate', () => {
  const catalog = firstMateProjectCatalog(
    [requestProject(alpha), requestProject(beta)],
    alpha.id,
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )
  const metadata = fakeCaptainSelectOne(catalog, 'alpha')
  assert.ok(metadata)
  const context = firstMateTaskContextFromMetadata(metadata)
  assert.ok(context)

  const registered = registrationFor(alpha).project!
  const gateProject: FirstMateSpawnGateProject = {
    adeProjectId: registered.adeProjectId,
    registryName: registered.registryName,
    windowsPath: registered.windowsPath,
    wslPath: registered.wslPath,
    mode: registered.mode,
    autonomy: registered.autonomy
  }
  assert.equal(
    firstMateSpawnContextProblem(context, gateProject, catalog.validator),
    undefined
  )
})

test('a dispatch against a project whose registration changed after the catalog was sent refuses', () => {
  const catalog = firstMateProjectCatalog(
    [requestProject(alpha)],
    alpha.id,
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )
  const metadata = fakeCaptainSelectOne(catalog, 'alpha')
  assert.ok(metadata)
  const context = firstMateTaskContextFromMetadata(metadata)
  assert.ok(context)

  const updatedProject: FirstMateSpawnGateProject = {
    adeProjectId: 'alpha',
    registryName: 'api-alpha',
    windowsPath: 'D:\\Development\\alpha\\api',
    wslPath: registeredWslPath('D:\\Development\\alpha\\api'),
    mode: 'direct-PR',
    autonomy: false
  }
  const problem = firstMateSpawnContextProblem(context, updatedProject, catalog.validator)
  assert.ok(problem, 'the spawn gate must refuse when the project posture drifted')
  assert.match(problem, /no-mistakes/)
  assert.match(problem, /direct-PR/)
})

test('a dispatch against a stale validator refuses when the provider changed', () => {
  const catalog = firstMateProjectCatalog(
    [requestProject(alpha)],
    alpha.id,
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )
  const metadata = fakeCaptainSelectOne(catalog, 'alpha')
  assert.ok(metadata)
  const context = firstMateTaskContextFromMetadata(metadata)
  assert.ok(context)

  const registered = registrationFor(alpha).project!
  const gateProject: FirstMateSpawnGateProject = {
    adeProjectId: registered.adeProjectId,
    registryName: registered.registryName,
    windowsPath: registered.windowsPath,
    wslPath: registered.wslPath,
    mode: registered.mode,
    autonomy: registered.autonomy
  }
  const updatedValidator: FirstMateSpawnGateValidator = { agent: 'claude', model: 'claude-sonnet-4-5' }
  const problem = firstMateSpawnContextProblem(context, gateProject, updatedValidator)
  assert.ok(problem, 'the spawn gate must refuse when the validator drifted')
  assert.match(problem, /codex/)
  assert.match(problem, /claude/)
})

test('a non-active project selected by the captain passes when its registration is unchanged', () => {
  const catalog = firstMateProjectCatalog(
    [requestProject(alpha), requestProject(beta)],
    alpha.id,
    { provider: 'codex' }
  )
  const metadata = fakeCaptainSelectOne(catalog, 'beta')
  assert.ok(metadata)
  const context = firstMateTaskContextFromMetadata(metadata)
  assert.ok(context)

  const registered = registrationFor(beta).project!
  const gateProject: FirstMateSpawnGateProject = {
    adeProjectId: registered.adeProjectId,
    registryName: registered.registryName,
    windowsPath: registered.windowsPath,
    wslPath: registered.wslPath,
    mode: registered.mode,
    autonomy: registered.autonomy
  }
  assert.equal(
    firstMateSpawnContextProblem(context, gateProject, catalog.validator),
    undefined
  )
})
