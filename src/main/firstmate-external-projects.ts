import { createHash } from 'node:crypto'
import type {
  FirstMateActionResult,
  FirstMateDeliveryMode,
  FirstMateExternalProject,
  FirstMateProjectInitialization,
  FirstMateProjectRegistration,
  FirstMateProjectSelection
} from '../shared/firstmate'
import { firstMateOriginSafe } from './firstmate-project-origin'

/**
 * ADE's own registration file inside the private FirstMate home. It maps ADE's stable project
 * identity to the durable external project, so a restart, a rename, or two projects sharing a
 * folder name never move a registration onto the wrong checkout.
 */
export const EXTERNAL_PROJECT_STORE_FILE = 'ade-external-projects.json'
/**
 * FirstMate's own fleet registry. It is firstmate-private and rebuilt from the clones under
 * `projects/` when absent, so ADE only ever reads it: an entry recorded there for one of these
 * checkouts is the captain's own record and outranks what ADE cached. Its line format and posture
 * vocabulary are owned by the managed distro's bin/fm-project-mode.sh.
 */
export const FLEET_REGISTRY_FILE = 'projects.md'

const DELIVERY_MODES: FirstMateDeliveryMode[] = ['no-mistakes', 'no-mistakes-prod-only', 'direct-PR', 'local-only']
/** FirstMate's own fallback for an unknown or unannotated registry entry, so a typo never drops the gate. */
const LEGACY_MODE: FirstMateDeliveryMode = 'no-mistakes'
const REGISTRY_ENTRY = /^-[ \t]+(\S+)(?:[ \t]+\[([^\]]*)\])?(.*)$/

interface FirstMateExternalProjectStore {
  version: 1
  projects: Record<string, FirstMateExternalProject>
}

export interface FirstMateCheckoutFacts {
  exists: boolean
  origin?: string
}

/** The two files this mapping reads: ADE's own registration store and FirstMate's fleet registry. */
export interface FirstMateExternalProjectFiles {
  store?: string
  registry?: string
}

/** The private FirstMate home's data directory, wherever it lives: this machine or ADE's WSL distro. */
export interface FirstMateExternalProjectHome {
  read(): Promise<FirstMateExternalProjectFiles>
  /** Writes ADE's own registration store. Nothing here may write a firstmate-private file. */
  writeStore(text: string): Promise<void>
}

export interface FirstMateExternalProjectOptions {
  home: FirstMateExternalProjectHome
  /** Reads the checkout without changing it: existence and the Git origin when the project has one. */
  inspectCheckout(windowsPath: string): Promise<FirstMateCheckoutFacts>
  today?(): string
}

export interface FirstMateExternalProjects {
  /** Validates and records the project behind one request; idempotent for an unchanged selection. */
  register(selection: FirstMateProjectSelection): Promise<FirstMateProjectRegistration>
  /** Reads what was recorded, without validating, mutating, or touching the checkout. */
  recorded(adeProjectId: string): Promise<FirstMateExternalProject | null>
  authorizeInitialization(adeProjectId: string): Promise<FirstMateProjectRegistration>
  /** Retires ADE's mapping. FirstMate project removal stays FirstMate's own captain-approved operation. */
  retire(adeProjectId: string): Promise<FirstMateActionResult>
}

interface FleetRegistryEntry {
  name: string
  mode: FirstMateDeliveryMode
  autonomy: boolean
  line: string
}

interface ExternalProjectRequest {
  adeProjectId: string
  displayName: string
  windowsPath: string
  wslPath: string
  origin?: string
}

interface RecordedPosture {
  registryName: string
  mode: FirstMateDeliveryMode
  autonomy: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function firstMateCanonicalWindowsPath(path: string): string | null {
  const trimmed = path.trim()
  if (!/^[a-zA-Z]:[\\/]/.test(trimmed)) return null
  const drive = trimmed[0].toUpperCase()
  const rest = trimmed.slice(3).replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`
}

export function firstMateWslPath(canonicalWindowsPath: string): string {
  const drive = canonicalWindowsPath[0].toLocaleLowerCase()
  const rest = canonicalWindowsPath.slice(3).replace(/\\/g, '/')
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`
}

function deliveryMode(value: unknown): FirstMateDeliveryMode | undefined {
  return DELIVERY_MODES.find((mode) => mode === value)
}

function defaultDeliveryMode(origin?: string): FirstMateDeliveryMode {
  return origin ? 'no-mistakes-prod-only' : 'local-only'
}

/** no-mistakes initialization writes inside the checkout, so it is a requirement, never a side effect. */
function requiredInitialization(mode: FirstMateDeliveryMode): FirstMateProjectInitialization {
  return mode === 'no-mistakes' || mode === 'no-mistakes-prod-only' ? 'required' : 'not-required'
}

function slug(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

function pathSegments(canonicalWindowsPath: string): string[] {
  return canonicalWindowsPath.slice(3).split('\\').filter(Boolean)
}

/**
 * Names ADE proposes for one checkout, most legible first: the directory name, then the directory
 * qualified by its parent, then a digest of the canonical path. Two projects sharing a basename get
 * different names, and the chosen name is recorded once and never re-derived.
 */
function registryNameCandidates(canonicalWindowsPath: string, wslPath: string): string[] {
  const segments = pathSegments(canonicalWindowsPath)
  const base = slug(segments.at(-1) ?? '') || 'project'
  const parent = slug(segments.at(-2) ?? '')
  const digest = createHash('sha256').update(wslPath).digest('hex').slice(0, 8)
  return [base, ...(parent && parent !== base ? [`${base}-${parent}`] : []), `${base}-${digest}`]
}

/** True when the line names this exact path as a whole token rather than merely containing its text. */
function namesPath(line: string, path: string, caseSensitive: boolean): boolean {
  const haystack = caseSensitive ? line : line.toLocaleLowerCase()
  const needle = caseSensitive ? path : path.toLocaleLowerCase()
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    const before = line[index - 1]
    const following = line[index + needle.length]
    const opens = before === undefined || /[\s("']/.test(before)
    const closes = following === undefined || /[\s)\],;"']/.test(following)
    if (opens && closes) return true
  }
  return false
}

/** Linux paths are case-sensitive; the Windows form of the same checkout is not. */
function registryEntryForCheckout(
  entries: FleetRegistryEntry[],
  request: ExternalProjectRequest
): FleetRegistryEntry | undefined {
  return entries.find((entry) => (
    namesPath(entry.line, request.wslPath, true) || namesPath(entry.line, request.windowsPath, false)
  ))
}

function parseFleetRegistry(text?: string): FleetRegistryEntry[] {
  const entries: FleetRegistryEntry[] = []
  for (const line of (text ?? '').split(/\r?\n/)) {
    const match = REGISTRY_ENTRY.exec(line.trim())
    if (!match) continue
    const annotation = (match[2] ?? '').split(/\s+/).filter(Boolean)
    const declared = annotation.find((token) => token !== '+yolo')
    entries.push({
      name: match[1],
      mode: declared === undefined ? LEGACY_MODE : deliveryMode(declared) ?? LEGACY_MODE,
      autonomy: annotation.includes('+yolo'),
      line
    })
  }
  return entries
}

function storedProject(value: unknown, key: string, today: string): FirstMateExternalProject | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const text = (candidate: unknown): string | undefined => (
    typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
  )
  const identity = text(record.adeProjectId) ?? text(record.projectId) ?? text(record.id) ?? text(key)
  const rawPath = text(record.windowsPath) ?? text(record.path)
  const windowsPath = rawPath ? firstMateCanonicalWindowsPath(rawPath) : null
  if (!identity || !windowsPath) return null
  const origin = text(record.origin)
  const declared = deliveryMode(record.mode)
  // An ad-hoc record with no posture takes today's default; one with an unreadable posture takes
  // FirstMate's own conservative fallback rather than silently dropping a gate.
  const mode = declared ?? (record.mode === undefined ? defaultDeliveryMode(origin) : LEGACY_MODE)
  return {
    adeProjectId: identity,
    registryName: text(record.registryName) ?? '',
    displayName: text(record.displayName) ?? text(record.name) ?? (pathSegments(windowsPath).at(-1) ?? windowsPath),
    windowsPath,
    wslPath: firstMateWslPath(windowsPath),
    ...(origin ? { origin } : {}),
    mode,
    autonomy: record.autonomy === true || record.yolo === true || record.yolo === 'on',
    initialization: record.initialization === 'authorized' ? 'authorized' : requiredInitialization(mode),
    registeredAt: text(record.registeredAt) ?? today
  }
}

/**
 * Reads ADE's registration file, including an ad-hoc shape written before this store existed: a list
 * or a loosely keyed map whose recorded delivery posture and autonomy are preserved as they stand.
 */
function parseExternalProjectStore(text: string | undefined, today: string): FirstMateExternalProjectStore {
  const store: FirstMateExternalProjectStore = { version: 1, projects: {} }
  if (!text) return store
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return store
  }
  const projects = (parsed as { projects?: unknown })?.projects
  const candidates: [string, unknown][] = Array.isArray(parsed)
    ? parsed.map((entry, index) => [`ade-project-${index}`, entry])
    : projects && typeof projects === 'object'
      ? Object.entries(projects as Record<string, unknown>)
      : parsed && typeof parsed === 'object'
        ? Object.entries(parsed as Record<string, unknown>)
        : []
  const taken = new Set<string>()
  for (const [key, value] of candidates) {
    const project = storedProject(value, key, today)
    if (!project || store.projects[project.adeProjectId]) continue
    const registryName = project.registryName
      || registryNameCandidates(project.windowsPath, project.wslPath).find((name) => !taken.has(name))
      || project.wslPath
    taken.add(registryName)
    store.projects[project.adeProjectId] = { ...project, registryName }
  }
  return store
}

function serializeExternalProjectStore(store: FirstMateExternalProjectStore): string {
  return `${JSON.stringify(store, null, 2)}\n`
}

/**
 * Which posture this registration carries, in precedence order:
 * 1. FirstMate's own fleet registry entry for this checkout, which the captain owns and may edit.
 * 2. Otherwise whatever ADE already recorded, which is never reinterpreted or migrated.
 * 3. Otherwise the standing default: remote-backed projects run the pipeline, the rest stay local.
 */
function recordedPosture(
  request: ExternalProjectRequest,
  existing: FirstMateExternalProject | undefined,
  entry: FleetRegistryEntry | undefined,
  unusedName: () => string
): RecordedPosture {
  if (entry) return { registryName: entry.name, mode: entry.mode, autonomy: entry.autonomy }
  if (existing) {
    return { registryName: existing.registryName, mode: existing.mode, autonomy: existing.autonomy }
  }
  return { registryName: unusedName(), mode: defaultDeliveryMode(request.origin), autonomy: false }
}

function resolveRegistration(
  request: ExternalProjectRequest,
  store: FirstMateExternalProjectStore,
  entries: FleetRegistryEntry[],
  today: string
): { project: FirstMateExternalProject; changed: boolean } {
  const existing = store.projects[request.adeProjectId]
  const claimed = new Set(
    Object.values(store.projects)
      .filter((project) => project.adeProjectId !== request.adeProjectId)
      .map((project) => project.registryName)
  )
  const posture = recordedPosture(
    request,
    existing,
    registryEntryForCheckout(entries, request),
    () => registryNameCandidates(request.windowsPath, request.wslPath).find(
      (name) => !claimed.has(name) && !entries.some((entry) => entry.name === name)
    ) ?? request.wslPath
  )
  const required = requiredInitialization(posture.mode)
  const project: FirstMateExternalProject = {
    adeProjectId: request.adeProjectId,
    registryName: posture.registryName,
    displayName: request.displayName,
    windowsPath: request.windowsPath,
    wslPath: request.wslPath,
    ...(request.origin ? { origin: request.origin } : {}),
    mode: posture.mode,
    autonomy: posture.autonomy,
    initialization: existing?.initialization === 'authorized' && required === 'required' ? 'authorized' : required,
    registeredAt: existing?.registeredAt ?? today
  }
  return { project, changed: JSON.stringify(existing) !== JSON.stringify(project) }
}

export function createFirstMateExternalProjects(
  options: FirstMateExternalProjectOptions
): FirstMateExternalProjects {
  const today = options.today ?? ((): string => new Date().toISOString().slice(0, 10))
  let store: FirstMateExternalProjectStore = { version: 1, projects: {} }
  let entries: FleetRegistryEntry[] = []
  let loaded = false
  let queue: Promise<unknown> = Promise.resolve()
  const validated = new Set<string>()

  const refresh = async (): Promise<void> => {
    const files = await options.home.read()
    store = parseExternalProjectStore(files.store, today())
    entries = parseFleetRegistry(files.registry)
    loaded = true
  }

  const load = async (): Promise<void> => {
    if (!loaded) await refresh()
  }

  /** One writer at a time, so two requests can never interleave a read-modify-write of the home. */
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Writes the home first, so a failed write leaves the in-memory mapping matching what is recorded. */
  const commit = async (changes: Record<string, FirstMateExternalProject | undefined>): Promise<void> => {
    const projects = { ...store.projects }
    for (const [adeProjectId, project] of Object.entries(changes)) {
      if (project) projects[adeProjectId] = project
      else delete projects[adeProjectId]
    }
    const next: FirstMateExternalProjectStore = { version: 1, projects }
    await options.home.writeStore(serializeExternalProjectStore(next))
    store = next
  }

  const record = async (selection: FirstMateProjectSelection): Promise<FirstMateProjectRegistration> => {
    const windowsPath = firstMateCanonicalWindowsPath(selection.path)
    if (!selection.projectId || !windowsPath) {
      return { ok: false, message: `ADE cannot register the project path ${JSON.stringify(selection.path)}.` }
    }
    if (loaded) {
      const cached = store.projects[selection.projectId]
      if (
        cached
        && validated.has(selection.projectId)
        && cached.displayName === selection.name
        && cached.windowsPath === windowsPath
      ) {
        return { ok: true, project: { ...cached } }
      }
    }
    const facts = await options.inspectCheckout(windowsPath)
    if (!facts.exists) {
      return { ok: false, message: `ADE could not find the project checkout at ${windowsPath}.` }
    }
    if (facts.origin && !firstMateOriginSafe(facts.origin)) {
      return {
        ok: false,
        message: `The Git origin recorded in ${windowsPath} is not a safe clone URL: ${facts.origin}`
      }
    }
    await refresh()
    const resolved = resolveRegistration(
      {
        adeProjectId: selection.projectId,
        displayName: selection.name,
        windowsPath,
        wslPath: firstMateWslPath(windowsPath),
        ...(facts.origin ? { origin: facts.origin } : {})
      },
      store,
      entries,
      today()
    )
    if (resolved.changed) await commit({ [selection.projectId]: resolved.project })
    validated.add(selection.projectId)
    return { ok: true, project: { ...resolved.project } }
  }

  return {
    register: (selection) => serialize(() => record(selection)),
    async recorded(adeProjectId: string): Promise<FirstMateExternalProject | null> {
      return serialize(async () => {
        await load()
        const project = store.projects[adeProjectId]
        return project ? { ...project } : null
      })
    },
    async authorizeInitialization(adeProjectId: string): Promise<FirstMateProjectRegistration> {
      return serialize(async () => {
        await load()
        const project = store.projects[adeProjectId]
        if (!project) return { ok: false, message: 'That project is not registered with FirstMate yet.' }
        if (project.initialization === 'not-required') return { ok: true, project: { ...project } }
        const authorized: FirstMateExternalProject = { ...project, initialization: 'authorized' }
        await commit({ [adeProjectId]: authorized })
        return { ok: true, project: { ...authorized } }
      })
    },
    async retire(adeProjectId: string): Promise<FirstMateActionResult> {
      return serialize(async () => {
        await load()
        if (!store.projects[adeProjectId]) return { ok: true }
        try {
          await commit({ [adeProjectId]: undefined })
          validated.delete(adeProjectId)
          return { ok: true }
        } catch (error) {
          return { ok: false, message: errorMessage(error) }
        }
      })
    }
  }
}
