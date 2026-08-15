import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { FirstMateProjectRegistration } from '../src/shared/firstmate'
import type { WorkspaceProject } from '../src/shared/terminal'
import { firstMateProjectTarget, firstMateRequest } from '../src/renderer/src/firstmate-request-target'

const alpha: WorkspaceProject = { id: 'alpha', name: 'Api', path: 'D:\\Development\\alpha\\api', color: '#71a9ff' }
const beta: WorkspaceProject = { id: 'beta', name: 'Api', path: 'D:\\Development\\beta\\api', color: '#f0a' }
const gamma: WorkspaceProject = { id: 'gamma', name: 'Api', path: 'E:\\Archive\\gamma\\api', color: '#0fa' }

/**
 * Stands in for the dock: one conversation whose sidebar selection changes between requests, exactly
 * as FirstMatePanel composes each prompt from the project selected at that moment.
 */
function dock(selected: WorkspaceProject): {
  select(project: WorkspaceProject): void
  target(): ReturnType<typeof firstMateProjectTarget>
  send(text: string): string
  delivered: string[]
} {
  let selection = selected
  const delivered: string[] = []
  return {
    delivered,
    select: (project) => { selection = project },
    target: () => firstMateProjectTarget(selection),
    send: (text) => {
      const prompt = firstMateRequest(selection, text)
      delivered.push(prompt)
      return prompt
    }
  }
}

test('assigns each request to the project selected when the captain submitted it', () => {
  const panel = dock(alpha)

  panel.send('Ship the release')
  panel.select(beta)
  panel.send('Fix the build')

  assert.match(panel.delivered[0], /"alpha"[\s\S]*"\/mnt\/d\/Development\/alpha\/api"/)
  assert.doesNotMatch(panel.delivered[0], /beta/)
  assert.match(panel.delivered[1], /"beta"[\s\S]*"\/mnt\/d\/Development\/beta\/api"/)
  assert.doesNotMatch(panel.delivered[1], /alpha/)
})

test('delivers the assignment with the request while the captain message stays unchanged', () => {
  const panel = dock(alpha)

  const prompt = panel.send('Ship the release')

  assert.ok(prompt.startsWith('ADE project assignment'), 'the assignment should precede the captain text')
  assert.ok(prompt.endsWith('\n\nShip the release'), 'the captain text should follow the assignment verbatim')
  assert.match(prompt, /Windows path: "D:\\\\Development\\\\alpha\\\\api"/)
  assert.match(prompt, /use the absolute path above/)
})

test('a selection change after submission cannot retarget the request already sent', () => {
  const panel = dock(alpha)

  const inFlight = panel.send('Ship the release')
  panel.select(gamma)

  assert.equal(inFlight, panel.delivered[0])
  assert.doesNotMatch(panel.delivered[0], /gamma|Archive/)
  assert.match(panel.delivered[0], /even if the sidebar selection changes later/)
})

test('switching projects retargets the next request without any conversation reset', () => {
  const panel = dock(alpha)

  assert.equal(panel.target().projectId, 'alpha')
  panel.select(beta)

  assert.equal(panel.target().projectId, 'beta')
  assert.match(panel.send('Fix the build'), /"beta"/)
})

test('shows enough of the path to tell similarly named projects apart before submission', () => {
  const panel = dock(alpha)

  const shown = panel.target()
  panel.select(beta)
  const switched = panel.target()

  assert.equal(shown.name, switched.name)
  assert.notEqual(shown.windowsPath, switched.windowsPath)
})

test('snapshots the selected project as an immutable target', () => {
  const target = firstMateProjectTarget(alpha)

  assert.deepEqual({ ...target }, {
    projectId: 'alpha',
    name: 'Api',
    windowsPath: 'D:\\Development\\alpha\\api',
    wslPath: '/mnt/d/Development/alpha/api'
  })
  assert.ok(Object.isFrozen(target), 'a submitted request must not be retargeted through its snapshot')
})

const registered: FirstMateProjectRegistration = {
  ok: true,
  project: {
    adeProjectId: 'alpha',
    registryName: 'api-alpha',
    displayName: 'Api',
    windowsPath: 'D:\\Development\\alpha\\api',
    wslPath: '/mnt/d/Development/alpha/api',
    origin: 'git@github.com:acme/alpha-api.git',
    mode: 'no-mistakes-prod-only',
    autonomy: false,
    initialization: 'required',
    registeredAt: '2026-08-14'
  }
}

test('delivers the durable registration facts with the request', () => {
  const prompt = firstMateRequest(alpha, 'Ship the release', registered)

  assert.match(prompt, /- project name: "api-alpha"/)
  assert.match(prompt, /- registered delivery posture: "no-mistakes-prod-only"/)
  assert.match(prompt, /- autonomy \(\+yolo\): off/)
  assert.match(prompt, /- origin: "git@github.com:acme\/alpha-api.git"/)
  assert.match(prompt, /no-mistakes initialization: not run;[\s\S]*?authorizes it in ADE/)
  assert.match(prompt, /must never be cloned, copied, or symlinked there/)
  assert.match(
    prompt,
    /ADE does not write your firstmate-private fleet registry[\s\S]*?outranks it from then on/,
    'the captain keeps ownership of add intake and of the registered posture'
  )
  assert.ok(prompt.endsWith('\n\nShip the release'))
})

test('states that a project has no remote and needs no initialization', () => {
  const prompt = firstMateRequest(alpha, 'Ship the release', {
    ok: true,
    project: {
      ...registered.project!,
      mode: 'local-only',
      origin: undefined,
      initialization: 'not-required'
    }
  })

  assert.match(prompt, /- registered delivery posture: "local-only"/)
  assert.match(prompt, /- origin: none; this checkout has no remote/)
  assert.match(prompt, /- no-mistakes initialization: not required for this posture/)
})

test('refuses to compose a fallback prompt when project registration failed', () => {
  assert.throws(
    () => firstMateRequest(alpha, 'Ship the release', {
      ok: false,
      message: 'Path-access failure for ADE project "Api" (alpha).'
    }),
    /Path-access failure for ADE project "Api" \(alpha\)/
  )
})
