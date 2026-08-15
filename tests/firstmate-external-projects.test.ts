import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { FirstMateProjectSelection } from '../src/shared/firstmate'
import {
  createFirstMateExternalProjects,
  firstMateCanonicalWindowsPath,
  firstMateWslPath,
  type FirstMateCheckoutFacts,
  type FirstMateExternalProjectFiles,
  type FirstMateExternalProjectHome
} from '../src/main/firstmate-external-projects'
import { firstMateOriginSafe } from '../src/main/firstmate-project-origin'

const alpha: FirstMateProjectSelection = { projectId: 'alpha', name: 'Api', path: 'D:\\Development\\alpha\\api' }
const beta: FirstMateProjectSelection = { projectId: 'beta', name: 'Api', path: 'D:\\Development\\beta\\api' }
const gamma: FirstMateProjectSelection = { projectId: 'gamma', name: 'Api', path: 'E:\\Archive\\gamma\\api' }

interface HomeDouble {
  files: FirstMateExternalProjectFiles
  writes: string[]
  port: FirstMateExternalProjectHome
}

/** ADE's private FirstMate home, in memory, so a restart is just a second service over the same files. */
function home(initial: FirstMateExternalProjectFiles = {}): HomeDouble {
  const files: FirstMateExternalProjectFiles = { ...initial }
  const writes: string[] = []
  return {
    files,
    writes,
    port: {
      read: async () => ({ ...files }),
      writeStore: async (text) => {
        files.store = text
        writes.push('store')
      }
    }
  }
}

interface CheckoutDouble {
  inspected: string[]
  inspect(windowsPath: string): Promise<FirstMateCheckoutFacts>
}

function checkouts(facts: Record<string, FirstMateCheckoutFacts>): CheckoutDouble {
  const inspected: string[] = []
  return {
    inspected,
    inspect: async (windowsPath) => {
      inspected.push(windowsPath)
      return facts[windowsPath] ?? { exists: false }
    }
  }
}

const remoteBacked: Record<string, FirstMateCheckoutFacts> = {
  'D:\\Development\\alpha\\api': { exists: true, origin: 'git@github.com:acme/alpha-api.git' },
  'D:\\Development\\beta\\api': { exists: true, origin: 'https://github.com/acme/beta-api.git' },
  'E:\\Archive\\gamma\\api': { exists: true, origin: 'https://github.com/acme/gamma-api.git' }
}

function projects(
  files: FirstMateExternalProjectFiles = {},
  facts: Record<string, FirstMateCheckoutFacts> = remoteBacked,
  wslAccess: Record<string, { accessible: boolean; message?: string }> = {}
): { home: HomeDouble; checkout: CheckoutDouble; service: ReturnType<typeof createFirstMateExternalProjects> } {
  const homeDouble = home(files)
  const checkout = checkouts(facts)
  return {
    home: homeDouble,
    checkout,
    service: createFirstMateExternalProjects({
      home: homeDouble.port,
      inspectCheckout: checkout.inspect,
      inspectWslPath: async (wslPath) => wslAccess[wslPath] ?? { accessible: true },
      today: () => '2026-08-14'
    })
  }
}

test('records the validated identity, canonical paths, origin, and posture on the first request', async () => {
  const { home: files, service } = projects()

  const result = await service.register(alpha)

  assert.deepEqual(result, {
    ok: true,
    project: {
      adeProjectId: 'alpha',
      registryName: 'api',
      displayName: 'Api',
      windowsPath: 'D:\\Development\\alpha\\api',
      wslPath: '/mnt/d/Development/alpha/api',
      origin: 'git@github.com:acme/alpha-api.git',
      mode: 'no-mistakes-prod-only',
      autonomy: false,
      initialization: 'required',
      registeredAt: '2026-08-14'
    }
  })
  assert.match(files.files.store ?? '', /"mode": "no-mistakes-prod-only"/)
  assert.deepEqual(files.writes, ['store'], 'only ADE\'s own registration file is written')
  assert.equal(
    files.files.registry,
    undefined,
    'the firstmate-private fleet registry belongs to the captain and stays untouched'
  )
})

test('restores the recorded mapping before the first request after a restart', async () => {
  const first = projects()
  await first.service.register(alpha)

  const restarted = projects(first.home.files)
  const restored = await restarted.service.recorded('alpha')

  assert.deepEqual(restored, (await first.service.recorded('alpha')))
  assert.equal(restored?.registryName, 'api')
  assert.deepEqual(restarted.home.writes, [], 'restoring a registration must not rewrite the home')
  assert.deepEqual(restarted.checkout.inspected, [], 'reading a registration must not touch the checkout')
})

test('defaults a project with no remote to local-only and requires no initialization', async () => {
  const { home: files, service } = projects({}, {
    'D:\\Development\\alpha\\api': { exists: true }
  })

  const result = await service.register(alpha)

  assert.equal(result.project?.mode, 'local-only')
  assert.equal(result.project?.origin, undefined)
  assert.equal(result.project?.initialization, 'not-required')
  assert.equal(result.project?.autonomy, false)
  assert.match(files.files.store ?? '', /"mode": "local-only"/)
})

test('keeps autonomy off for a new registration and preserves an explicitly recorded one', async () => {
  const recorded = JSON.stringify({
    version: 1,
    projects: {
      alpha: {
        adeProjectId: 'alpha',
        registryName: 'api',
        displayName: 'Api',
        windowsPath: 'D:\\Development\\alpha\\api',
        wslPath: '/mnt/d/Development/alpha/api',
        origin: 'git@github.com:acme/alpha-api.git',
        mode: 'direct-PR',
        autonomy: true,
        initialization: 'not-required',
        registeredAt: '2026-07-01'
      }
    }
  })
  const { service } = projects({ store: recorded })

  const kept = await service.register(alpha)
  const fresh = await service.register(beta)

  assert.equal(kept.project?.autonomy, true)
  assert.equal(kept.project?.mode, 'direct-PR')
  assert.equal(fresh.project?.autonomy, false)
})

test('a posture the captain recorded in the fleet registry outranks the one ADE cached', async () => {
  const cached = JSON.stringify({
    version: 1,
    projects: {
      alpha: {
        adeProjectId: 'alpha',
        registryName: 'api',
        displayName: 'Api',
        windowsPath: 'D:\\Development\\alpha\\api',
        wslPath: '/mnt/d/Development/alpha/api',
        mode: 'local-only',
        autonomy: false,
        initialization: 'not-required',
        registeredAt: '2026-07-01'
      }
    }
  })
  const { home: files, service } = projects({
    store: cached,
    registry: '- alpha-api [no-mistakes +yolo] - the api service at /mnt/d/Development/alpha/api (added 2026-08-01)\n'
  })

  const result = await service.register(alpha)

  assert.equal(result.project?.mode, 'no-mistakes')
  assert.equal(result.project?.autonomy, true)
  assert.equal(result.project?.registryName, 'alpha-api')
  assert.equal(result.project?.initialization, 'required', 'the captain\'s posture decides whether the gate applies')
  assert.match(files.files.store ?? '', /"mode": "no-mistakes"/, 'ADE re-records what the registry says')
})

test('ignores a registry entry that merely mentions a different checkout under the same parent', async () => {
  const { service } = projects({
    registry: '# Projects\n\n- sibling [direct-PR] - at /mnt/d/Development/alpha/api-tools (added 2026-08-01)\n'
  })

  const result = await service.register(alpha)

  assert.equal(result.project?.registryName, 'api')
  assert.equal(result.project?.mode, 'no-mistakes-prod-only', 'another project\'s entry must not hand over its posture')
})

test('keeps projects with identical display names and basenames distinct', async () => {
  const { home: files, service } = projects()

  const first = await service.register(alpha)
  const second = await service.register(beta)
  const third = await service.register(gamma)

  assert.deepEqual(
    [first.project?.registryName, second.project?.registryName, third.project?.registryName],
    ['api', 'api-beta', 'api-gamma']
  )
  assert.deepEqual(
    [first.project?.wslPath, second.project?.wslPath, third.project?.wslPath],
    ['/mnt/d/Development/alpha/api', '/mnt/d/Development/beta/api', '/mnt/e/Archive/gamma/api']
  )
  assert.equal(
    new Set(Object.values(JSON.parse(files.files.store ?? '{}').projects).map(
      (project) => (project as { registryName: string }).registryName
    )).size,
    3,
    'each project needs its own stable name'
  )
  assert.equal((await service.recorded('beta'))?.registryName, 'api-beta')
})

test('migrates ad-hoc registry data without losing its recorded standing posture', async () => {
  const adHoc = JSON.stringify([
    { id: 'alpha', name: 'Api', path: 'D:\\Development\\alpha\\api', mode: 'direct-PR', yolo: 'on' },
    { id: 'beta', name: 'Api', path: 'D:/Development/beta/api/' }
  ])
  const { home: files, service } = projects({ store: adHoc })

  const migrated = await service.register(alpha)
  const reconciled = await service.register(beta)

  assert.equal(migrated.project?.mode, 'direct-PR')
  assert.equal(migrated.project?.autonomy, true)
  assert.equal(migrated.project?.wslPath, '/mnt/d/Development/alpha/api')
  assert.equal(reconciled.project?.windowsPath, 'D:\\Development\\beta\\api')
  assert.equal(reconciled.project?.registryName, 'api-beta')
  assert.match(files.files.store ?? '', /"version": 1/, 'the migrated store should be written in its current shape')
})

test('adopts the posture an existing fleet registry entry already recorded for the same checkout', async () => {
  const { home: files, service } = projects({
    registry: '# Projects\n\n- alpha-api - the api service at D:\\Development\\alpha\\api (added 2026-01-02)\n'
  })

  const result = await service.register(alpha)

  assert.equal(result.project?.registryName, 'alpha-api')
  assert.equal(result.project?.mode, 'no-mistakes', 'a legacy entry without an annotation keeps meaning no-mistakes')
  assert.equal(result.project?.autonomy, false)
  assert.equal(
    files.files.registry,
    '# Projects\n\n- alpha-api - the api service at D:\\Development\\alpha\\api (added 2026-01-02)\n',
    'reconciling reads the captain\'s registry and never rewrites it'
  )
})

test('refuses a checkout that is missing or carries an unsafe origin, recording nothing', async () => {
  const { home: files, service } = projects({}, {
    'D:\\Development\\beta\\api': { exists: true, origin: 'ext::sh -c payload' }
  })

  const missing = await service.register(alpha)
  const unsafe = await service.register(beta)

  assert.equal(missing.ok, false)
  assert.match(missing.message ?? '', /D:\\Development\\alpha\\api/)
  assert.equal(unsafe.ok, false)
  assert.match(unsafe.message ?? '', /origin/i)
  assert.equal(files.files.store, undefined, 'a refused registration must not be recorded')
  assert.equal(files.files.registry, undefined)
  assert.equal(await service.recorded('alpha'), null)
})

test('classifies a project selection that cannot become a canonical Windows checkout path', async () => {
  const { checkout, service } = projects()

  const result = await service.register({ ...alpha, path: '\\\\server\\share\\api' })

  assert.equal(result.ok, false)
  assert.deepEqual(result.failure, { kind: 'selection', adeProjectId: 'alpha' })
  assert.match(result.message ?? '', /canonical Windows path/i)
  assert.deepEqual(checkout.inspected, [], 'an invalid selection must not probe a fallback directory')
})

test('revalidates a registered checkout on every request and recovers after the same project is restored', async () => {
  const facts: Record<string, FirstMateCheckoutFacts> = {
    'D:\\Development\\alpha\\api': remoteBacked['D:\\Development\\alpha\\api']!
  }
  const { service } = projects({}, facts)

  assert.equal((await service.register(alpha)).ok, true)
  facts['D:\\Development\\alpha\\api'] = { exists: false }

  const missing = await service.register(alpha)

  assert.equal(missing.ok, false)
  assert.deepEqual(missing.failure, { kind: 'path-access', adeProjectId: 'alpha' })
  assert.match(missing.message ?? '', /ADE project "Api" \(alpha\)/)

  facts['D:\\Development\\alpha\\api'] = remoteBacked['D:\\Development\\alpha\\api']!
  const repaired = await service.register(alpha)

  assert.equal(repaired.ok, true)
  assert.equal(repaired.project?.adeProjectId, 'alpha')
})

test('blocks a directory that is not a usable Git checkout before registration', async () => {
  const { home: files, service } = projects({}, {
    'D:\\Development\\alpha\\api': { exists: true, git: 'not-checkout' }
  })

  const result = await service.register(alpha)

  assert.equal(result.ok, false)
  assert.deepEqual(result.failure, { kind: 'git', adeProjectId: 'alpha' })
  assert.match(result.message ?? '', /not a usable Git checkout/i)
  assert.equal(files.files.store, undefined)
})

test('classifies an unavailable WSL mount and succeeds when the mount is restored', async () => {
  const access: Record<string, { accessible: boolean; message?: string }> = {
    '/mnt/d/Development/alpha/api': {
      accessible: false,
      message: 'Restore the D: drive mount in Ubuntu WSL.'
    }
  }
  const { home: files, service } = projects({}, remoteBacked, access)

  const unavailable = await service.register(alpha)

  assert.equal(unavailable.ok, false)
  assert.deepEqual(unavailable.failure, { kind: 'wsl', adeProjectId: 'alpha' })
  assert.match(unavailable.message ?? '', /Restore the D: drive mount/)
  assert.equal(files.files.store, undefined)

  access['/mnt/d/Development/alpha/api'] = { accessible: true }
  const restored = await service.register(alpha)

  assert.equal(restored.ok, true)
  assert.equal(restored.project?.wslPath, '/mnt/d/Development/alpha/api')
})

test('requires user action when another stable ADE identity already claims a replacement path', async () => {
  const { service } = projects()
  await service.register(alpha)
  await service.register(beta)

  const ambiguous = await service.register({ ...alpha, path: beta.path })

  assert.equal(ambiguous.ok, false)
  assert.deepEqual(ambiguous.failure, { kind: 'registration', adeProjectId: 'alpha' })
  assert.match(ambiguous.message ?? '', /already registered to ADE project "Api" \(beta\)/)
  assert.match(ambiguous.message ?? '', /reselect/i)
  assert.equal((await service.recorded('alpha'))?.windowsPath, alpha.path)
  assert.equal((await service.recorded('beta'))?.windowsPath, beta.path)
})

test('requires user action when the fleet registry has multiple entries for the exact checkout', async () => {
  const { service } = projects({
    registry: [
      '- alpha-api [direct-PR] - at /mnt/d/Development/alpha/api',
      '- old-alpha [no-mistakes] - at D:\\Development\\alpha\\api'
    ].join('\n')
  })

  const ambiguous = await service.register(alpha)

  assert.equal(ambiguous.ok, false)
  assert.deepEqual(ambiguous.failure, { kind: 'registration', adeProjectId: 'alpha' })
  assert.match(ambiguous.message ?? '', /multiple FirstMate fleet entries/i)
})

test('refuses duplicate stale records for one stable identity instead of choosing one after restart', async () => {
  const duplicateStore = JSON.stringify([
    { id: 'alpha', name: 'Api', path: 'D:\\Old\\api', mode: 'direct-PR' },
    { id: 'alpha', name: 'Api', path: 'D:\\Development\\alpha\\api', mode: 'no-mistakes' }
  ])
  const { service } = projects({ store: duplicateStore })

  const ambiguous = await service.register(alpha)

  assert.equal(ambiguous.ok, false)
  assert.deepEqual(ambiguous.failure, { kind: 'registration', adeProjectId: 'alpha' })
  assert.match(ambiguous.message ?? '', /multiple records for stable identity alpha/i)
  assert.match(ambiguous.message ?? '', /remove the stale duplicate/i)
})

test('revalidates WSL access after restart and recovers the existing registration after remount', async () => {
  const first = projects()
  const registered = await first.service.register(alpha)
  assert.equal(registered.ok, true)

  const access: Record<string, { accessible: boolean; message?: string }> = {
    '/mnt/d/Development/alpha/api': { accessible: false, message: 'Restore the D: drive mount.' }
  }
  const restarted = projects(first.home.files, remoteBacked, access)

  const unavailable = await restarted.service.register(alpha)
  assert.equal(unavailable.failure?.kind, 'wsl')
  assert.deepEqual(await restarted.service.recorded('alpha'), registered.project)

  access['/mnt/d/Development/alpha/api'] = { accessible: true }
  const recovered = await restarted.service.register(alpha)

  assert.equal(recovered.ok, true)
  assert.deepEqual(recovered.project, registered.project)
})

test('never initializes a checkout during registration and keeps authorization separate', async () => {
  const { home: files, service } = projects()

  const registered = await service.register(alpha)
  const authorized = await service.authorizeInitialization('alpha')
  const later = await service.register(alpha)

  assert.equal(registered.project?.initialization, 'required')
  assert.equal(authorized.project?.initialization, 'authorized')
  assert.equal(later.project?.initialization, 'authorized', 'an authorization survives every later request')
  assert.match(files.files.store ?? '', /"initialization": "authorized"/)
  assert.equal((await projects(files.files).service.recorded('alpha'))?.initialization, 'authorized')
})

test('a rename updates only the renamed project registration', async () => {
  const { service } = projects()
  await service.register(alpha)
  await service.register(beta)

  const renamed = await service.register({ ...alpha, name: 'Alpha API' })

  assert.equal(renamed.project?.displayName, 'Alpha API')
  assert.equal(renamed.project?.registryName, 'api', 'a display rename must not move the stable registry identity')
  assert.equal(renamed.project?.registeredAt, '2026-08-14')
  assert.equal((await service.recorded('beta'))?.displayName, 'Api')
  assert.equal((await service.recorded('beta'))?.registryName, 'api-beta')
})

test('a path change re-canonicalizes the moved project and keeps its recorded posture', async () => {
  const moved = 'D:\\Work\\alpha-api'
  const { service } = projects({}, { ...remoteBacked, [moved]: { exists: true } })
  await service.register(alpha)
  await service.register(beta)

  const result = await service.register({ ...alpha, path: `${moved}\\` })

  assert.equal(result.project?.windowsPath, moved)
  assert.equal(result.project?.wslPath, '/mnt/d/Work/alpha-api')
  assert.equal(result.project?.mode, 'no-mistakes-prod-only', 'a recorded posture is never reinterpreted')
  assert.equal(result.project?.registryName, 'api')
  assert.equal((await service.recorded('beta'))?.wslPath, '/mnt/d/Development/beta/api')
})

test('retiring a project removes only its registration and leaves the checkout alone', async () => {
  const registry = '# Projects\n\n- firstmate [no-mistakes] - the managed distro (added 2026-01-01)\n'
  const { home: files, checkout, service } = projects({ registry })
  await service.register(alpha)
  await service.register(beta)

  const retired = await service.retire('alpha')

  assert.deepEqual(retired, { ok: true })
  assert.equal(await service.recorded('alpha'), null)
  assert.equal((await service.recorded('beta'))?.registryName, 'api-beta')
  assert.equal(files.files.registry, registry, 'retiring an ADE mapping is not a FirstMate project removal')
  assert.deepEqual(
    checkout.inspected,
    ['D:\\Development\\alpha\\api', 'D:\\Development\\beta\\api'],
    'retirement must not reach into the checkout'
  )
  assert.deepEqual(await service.retire('alpha'), { ok: true }, 'retiring an unknown project is not an error')
})

test('canonicalizes Windows paths and maps them to their WSL form', () => {
  assert.equal(firstMateCanonicalWindowsPath('d:/Development/alpha/api/'), 'D:\\Development\\alpha\\api')
  assert.equal(firstMateCanonicalWindowsPath('D:\\Development\\\\alpha\\api'), 'D:\\Development\\alpha\\api')
  assert.equal(firstMateCanonicalWindowsPath('D:\\'), 'D:\\')
  assert.equal(firstMateCanonicalWindowsPath('  \\\\server\\share  '), null)
  assert.equal(firstMateCanonicalWindowsPath('relative\\path'), null)
  assert.equal(firstMateWslPath('D:\\Development\\alpha\\api'), '/mnt/d/Development/alpha/api')
  assert.equal(firstMateWslPath('D:\\'), '/mnt/d')
})

test('accepts the clone URL forms FirstMate accepts and refuses the unsafe ones', () => {
  for (const origin of [
    'https://github.com/acme/api.git',
    'https://user@git.example.internal:8443/acme/api.git',
    'ssh://git@[2001:db8::1]:22/acme/api.git',
    'git@github.com:acme/api.git',
    'gitlab-work:acme/api.git',
    'file:///srv/git/api.git',
    '/srv/git/api.git'
  ]) {
    assert.equal(firstMateOriginSafe(origin), true, origin)
  }
  for (const origin of [
    '',
    'ext::sh -c payload',
    '--upload-pack=payload',
    'https://github.com/acme/api.git\nhttps://evil.example/x',
    'unknown://host/repo',
    'file:///srv/../etc/passwd',
    '/srv/git/../../etc/passwd',
    'relative/path.git'
  ]) {
    assert.equal(firstMateOriginSafe(origin), false, JSON.stringify(origin))
  }
})
