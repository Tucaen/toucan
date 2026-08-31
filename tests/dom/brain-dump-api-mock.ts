import { vi } from 'vitest'
import type {
  BrainDumpApi,
  BrainDumpCaptureState,
  BrainDumpCollection,
  BrainDumpListResult,
  BrainDumpTopic
} from '../../src/shared/brain-dump'

/**
 * A brain-dump library the panel can actually be driven against: collections are plain arrays the
 * test edits, every call is a spy, and capture events can be published on demand so background-job
 * behavior is exercised through the same subscription the preload bridge uses.
 */

export interface MockBrainDumpApi extends BrainDumpApi {
  collections: Record<BrainDumpCollection, BrainDumpListResult>
  /** Pushes a capture state to every subscriber, exactly as the main process would. */
  publishCapture(state: BrainDumpCaptureState): void
  listCalls: BrainDumpCollection[]
}

export function topicFixture(overrides: Partial<BrainDumpTopic> & Pick<BrainDumpTopic, 'slug'>): BrainDumpTopic {
  return {
    title: overrides.slug,
    created: '2026-08-01',
    updated: '2026-08-01',
    collection: 'active',
    markdown: `---\ntitle: ${overrides.slug}\n---\n\nBody of ${overrides.slug}.`,
    ...overrides
  }
}

export function createMockBrainDumpApi(overrides: Partial<BrainDumpApi> = {}): MockBrainDumpApi {
  const subscribers = new Set<(state: BrainDumpCaptureState) => void>()
  const collections: Record<BrainDumpCollection, BrainDumpListResult> = {
    active: { topics: [], diagnostics: [] },
    archived: { topics: [], diagnostics: [] }
  }
  const listCalls: BrainDumpCollection[] = []

  const api: MockBrainDumpApi = {
    collections,
    listCalls,
    publishCapture(state) {
      for (const subscriber of subscribers) subscriber(state)
    },
    list: vi.fn(async (collection: BrainDumpCollection) => {
      listCalls.push(collection)
      return { topics: [...collections[collection].topics], diagnostics: [...collections[collection].diagnostics] }
    }),
    resolve: vi.fn(async (slug: string) => {
      for (const collection of ['active', 'archived'] as const) {
        const topic = collections[collection].topics.find((candidate) => candidate.slug === slug)
        if (topic) return { status: 'found' as const, slug, collection, topic }
      }
      return { status: 'missing' as const, slug }
    }),
    archive: vi.fn(async (slug: string, outcome) => {
      const index = collections.active.topics.findIndex((topic) => topic.slug === slug)
      if (index < 0) return { ok: false as const, code: 'missing-source', message: 'Gone.' }
      const [moved] = collections.active.topics.splice(index, 1)
      const archived = { ...moved, collection: 'archived' as const, outcome, archived: '2026-08-31' }
      collections.archived.topics.unshift(archived)
      return { ok: true as const, topic: archived }
    }),
    reopen: vi.fn(async (slug: string) => {
      const index = collections.archived.topics.findIndex((topic) => topic.slug === slug)
      if (index < 0) return { ok: false as const, code: 'missing-source', message: 'Gone.' }
      const [moved] = collections.archived.topics.splice(index, 1)
      const active = { ...moved, collection: 'active' as const, outcome: undefined, archived: undefined }
      collections.active.topics.unshift(active)
      return { ok: true as const, topic: active }
    }),
    startCapture: vi.fn(async () => ({ ok: true as const, state: { status: 'working' as const, jobId: 'job-1' } })),
    currentCapture: vi.fn(async () => null),
    cancelCapture: vi.fn(async () => undefined),
    onCapture: (callback) => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    ...overrides
  }
  return api
}
