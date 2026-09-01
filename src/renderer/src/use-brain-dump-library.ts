import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrainDumpApi,
  BrainDumpCaptureRequest,
  BrainDumpCaptureStartResult,
  BrainDumpCaptureState,
  BrainDumpCollection,
  BrainDumpDiagnostic,
  BrainDumpOutcome,
  BrainDumpTopic
} from '../../shared/brain-dump'
import { nextBrainDumpSelection } from './brain-dump-topics'

/**
 * The one owner of the library's async state: what each collection holds, which topic is selected
 * in it, whether a lifecycle change or a background capture is in flight, and what the polite live
 * region should announce. The panel and its children render this interface and never talk to
 * `window.brainDumpApi` themselves, so "read it back from disk" stays the single source of truth
 * for what the library contains - assistant prose never becomes state.
 */

export type BrainDumpCollectionStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface BrainDumpCollectionState {
  status: BrainDumpCollectionStatus
  topics: BrainDumpTopic[]
  diagnostics: BrainDumpDiagnostic[]
  error?: string
  /** The row selected in this collection, remembered while the user is looking at the other one. */
  selectedSlug?: string
  query: string
}

/** In-flight state of one library mutation - an archive, a reassignment - and its last failure. */
export interface BrainDumpMutationState {
  pending: boolean
  error?: string
}

export interface BrainDumpLibrary {
  collection: BrainDumpCollection
  selectCollection(collection: BrainDumpCollection): void
  active: BrainDumpCollectionState
  archived: BrainDumpCollectionState
  current: BrainDumpCollectionState
  setQuery(query: string): void
  selectTopic(slug: string | undefined): void
  /** Selects `slug` wherever it lives, switching collections when it is only in the other one. */
  openReference(slug: string): Promise<'opened' | 'missing'>
  /** Whether `slug` currently exists in either collection, without selecting anything. */
  resolveReference(slug: string): Promise<boolean>
  refresh(collection: BrainDumpCollection): Promise<void>
  lifecycle: BrainDumpMutationState
  archive(slug: string, outcome: BrainDumpOutcome): Promise<boolean>
  clearLifecycleError(): void
  /**
   * Files an active topic under another project, or under none. Kept apart from `lifecycle` so a
   * failed reassignment can never surface as an archive error, or the other way around.
   * `projectLabel` is only the display text the announcement uses; the path is what is written.
   */
  assignment: BrainDumpMutationState
  assignProject(slug: string, projectPath: string | undefined, projectLabel: string): Promise<boolean>
  clearAssignmentError(): void
  announcement: string
  capture: BrainDumpCaptureState | null
  startCapture(request: BrainDumpCaptureRequest): Promise<BrainDumpCaptureStartResult>
  cancelCapture(): void
  dismissCapture(): void
}

export interface BrainDumpLibraryOptions {
  api: BrainDumpApi
  /** Called after a completed capture's refresh succeeded, so the submitted draft can be cleared. */
  onCaptureFiled?(): void
}

const emptyCollection = (): BrainDumpCollectionState => ({
  status: 'idle',
  topics: [],
  diagnostics: [],
  query: ''
})

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The brain-dump library could not be read.'
}

/** The topic a refreshed collection gained or updated, which is what a capture just produced. */
function filedTopic(before: readonly BrainDumpTopic[], after: readonly BrainDumpTopic[]): string | undefined {
  const previous = new Map(before.map((topic) => [topic.slug, topic.updated]))
  return after.find((topic) => previous.get(topic.slug) !== topic.updated)?.slug
}

export function useBrainDumpLibrary(options: BrainDumpLibraryOptions): BrainDumpLibrary {
  const { api } = options
  const [collection, setCollection] = useState<BrainDumpCollection>('active')
  const [collections, setCollections] = useState<Record<BrainDumpCollection, BrainDumpCollectionState>>(() => ({
    active: emptyCollection(),
    archived: emptyCollection()
  }))
  const [lifecycle, setLifecycle] = useState<BrainDumpMutationState>({ pending: false })
  const [assignment, setAssignment] = useState<BrainDumpMutationState>({ pending: false })
  const [announcement, setAnnouncement] = useState('')
  const [capture, setCapture] = useState<BrainDumpCaptureState | null>(null)
  const captureRef = useRef(capture)
  captureRef.current = capture
  const captureRefreshPending = useRef(false)
  const collectionsRef = useRef(collections)
  collectionsRef.current = collections
  const onCaptureFiledRef = useRef(options.onCaptureFiled)
  onCaptureFiledRef.current = options.onCaptureFiled
  const filedJobs = useRef(new Set<string>())

  const patch = useCallback((target: BrainDumpCollection, next: Partial<BrainDumpCollectionState>): void => {
    setCollections((current) => ({ ...current, [target]: { ...current[target], ...next } }))
  }, [])

  const read = useCallback(
    async (target: BrainDumpCollection, background = false): Promise<BrainDumpTopic[]> => {
      if (!background) patch(target, { status: 'loading', error: undefined })
      try {
        const result = await api.list(target)
        setCollections((current) => {
          const previous = current[target]
          const selectedSlug = result.topics.some((topic) => topic.slug === previous.selectedSlug)
            ? previous.selectedSlug
            : undefined
          return {
            ...current,
            [target]: {
              ...previous,
              status: 'ready',
              topics: result.topics,
              diagnostics: result.diagnostics,
              error: undefined,
              selectedSlug
            }
          }
        })
        return result.topics
      } catch (cause) {
        patch(target, { status: 'error', error: errorText(cause) })
        return collectionsRef.current[target].topics
      }
    },
    [api, patch]
  )

  // Active topics load as soon as the panel exists; archived ones wait until the user asks for
  // them, so the common case never pays for a collection nobody opened.
  useEffect(() => {
    if (collectionsRef.current[collection].status !== 'idle') return
    void read(collection)
  }, [collection, read])

  useEffect(() => {
    let active = true
    void api
      .currentCapture()
      .then((state) => {
        if (active) setCapture(state)
      })
      .catch(() => undefined)
    const unsubscribe = api.onCapture((state) => setCapture(state))
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  useEffect(
    () =>
      api.onLibraryChange((target) => {
        // Keep unopened collections lazy. Their first ordinary read will already see the latest
        // disk state, while a visible or previously-opened collection refreshes without flashing
        // its loading state for every filesystem notification.
        const captureState = captureRef.current
        const captureWillReadActive =
          target === 'active' &&
          (captureState?.status === 'working' ||
            (captureState?.status === 'completed' && !filedJobs.current.has(captureState.jobId)) ||
            captureRefreshPending.current)
        if (!captureWillReadActive && collectionsRef.current[target].status !== 'idle') void read(target, true)
      }),
    [api, read]
  )

  // A finished capture is only believed once the library has been re-read from disk; the skill's
  // prose summarizes what it did, it does not define what the library now contains.
  useEffect(() => {
    if (capture?.status !== 'completed' || filedJobs.current.has(capture.jobId)) return
    filedJobs.current.add(capture.jobId)
    captureRefreshPending.current = true
    const before = collectionsRef.current.active.topics
    void read('active').then((after) => {
      const filed = filedTopic(before, after)
      if (filed) {
        setCollection('active')
        patch('active', { selectedSlug: filed })
      }
      setAnnouncement(capture.summary)
      onCaptureFiledRef.current?.()
      captureRefreshPending.current = false
    })
  }, [capture, patch, read])

  const setQuery = useCallback(
    (query: string): void => {
      patch(collection, { query })
    },
    [collection, patch]
  )

  const selectTopic = useCallback(
    (slug: string | undefined): void => {
      patch(collection, { selectedSlug: slug })
    },
    [collection, patch]
  )

  const openReference = useCallback(
    async (slug: string): Promise<'opened' | 'missing'> => {
      const resolved = await api.resolve(slug).catch(() => ({ status: 'missing' as const, slug }))
      if (resolved.status !== 'found') return 'missing'
      if (collectionsRef.current[resolved.collection].status === 'idle') await read(resolved.collection)
      setCollection(resolved.collection)
      patch(resolved.collection, { selectedSlug: slug })
      return 'opened'
    },
    [api, patch, read]
  )

  const resolveReference = useCallback(
    async (slug: string): Promise<boolean> => {
      const resolved = await api.resolve(slug).catch(() => ({ status: 'missing' as const, slug }))
      return resolved.status === 'found'
    },
    [api]
  )

  const move = useCallback(
    async (
      slug: string,
      run: () => ReturnType<BrainDumpApi['archive']>,
      from: BrainDumpCollection,
      to: BrainDumpCollection,
      announce: (topic: BrainDumpTopic) => string
    ): Promise<boolean> => {
      setLifecycle({ pending: true })
      let result
      try {
        result = await run()
      } catch (cause) {
        setLifecycle({ pending: false, error: errorText(cause) })
        return false
      }
      if (!result.ok) {
        setLifecycle({ pending: false, error: result.message })
        return false
      }
      const source = collectionsRef.current[from]
      const fallback = nextBrainDumpSelection(source.topics, slug)
      setCollections((current) => ({
        ...current,
        [from]: {
          ...current[from],
          topics: current[from].topics.filter((topic) => topic.slug !== slug),
          selectedSlug: current[from].selectedSlug === slug ? fallback : current[from].selectedSlug
        },
        // The destination is re-read when it is next opened; dropping it back to idle keeps the
        // moved topic from being missing there until then.
        [to]: current[to].status === 'ready' ? { ...current[to], status: 'idle' } : current[to]
      }))
      setLifecycle({ pending: false })
      setAnnouncement(announce(result.topic))
      return true
    },
    []
  )

  const archive = useCallback(
    (slug: string, outcome: BrainDumpOutcome): Promise<boolean> =>
      move(
        slug,
        () => api.archive(slug, outcome),
        'active',
        'archived',
        (topic) => `${topic.title} archived as ${outcome}. It stays available under Archived.`
      ),
    [api, move]
  )

  const assignProject = useCallback(
    async (slug: string, projectPath: string | undefined, projectLabel: string): Promise<boolean> => {
      setAssignment({ pending: true })
      let result
      try {
        result = await api.assignProject(slug, projectPath)
      } catch (cause) {
        setAssignment({ pending: false, error: errorText(cause) })
        return false
      }
      if (!result.ok) {
        setAssignment({ pending: false, error: result.message })
        return false
      }
      // The topic the library returned is what disk now holds, so it replaces the row in place
      // rather than being patched locally from what the picker happened to show.
      const assigned = result.topic
      setCollections((current) => ({
        ...current,
        active: {
          ...current.active,
          topics: current.active.topics.map((topic) => (topic.slug === slug ? assigned : topic))
        }
      }))
      setAssignment({ pending: false })
      setAnnouncement(`${assigned.title} is now filed under ${projectLabel}.`)
      return true
    },
    [api]
  )

  const startCapture = useCallback(
    async (request: BrainDumpCaptureRequest): Promise<BrainDumpCaptureStartResult> => {
      const result = await api.startCapture(request)
      if (result.ok) setCapture(result.state)
      return result
    },
    [api]
  )

  const cancelCapture = useCallback((): void => {
    if (capture?.status === 'working') void api.cancelCapture(capture.jobId)
  }, [api, capture])

  return useMemo(
    () => ({
      collection,
      selectCollection: setCollection,
      active: collections.active,
      archived: collections.archived,
      current: collections[collection],
      setQuery,
      selectTopic,
      openReference,
      resolveReference,
      refresh: async (target: BrainDumpCollection) => {
        await read(target)
      },
      lifecycle,
      archive,
      clearLifecycleError: () => setLifecycle({ pending: false }),
      assignment,
      assignProject,
      clearAssignmentError: () => setAssignment({ pending: false }),
      announcement,
      capture,
      startCapture,
      cancelCapture,
      dismissCapture: () => setCapture(null)
    }),
    [
      announcement,
      archive,
      assignProject,
      assignment,
      cancelCapture,
      capture,
      collection,
      collections,
      lifecycle,
      openReference,
      read,
      resolveReference,
      selectTopic,
      setQuery,
      startCapture
    ]
  )
}
