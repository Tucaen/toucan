import { vi } from 'vitest'
import type { TicketCard, TicketFilesApi, TicketSourceListResult } from '../../src/shared/ticket-source'

/**
 * The files ticket source as the preload bridge exposes it, backed by a plain array the test
 * edits. `setStatus` writes into that array before it resolves, which is what lets a test prove
 * the board only shows a move after the source has been re-read.
 */

export interface MockTicketsApi extends TicketFilesApi {
  /** Keyed by project path, exactly as the real bridge is. */
  projects: Map<string, TicketSourceListResult>
  /** Publishes a folder change, exactly as the main-process watcher would. */
  publishChange(projectPath: string): void
  listCalls: string[]
  revealCalls: Array<[string, string]>
}

export function cardFixture(overrides: Partial<TicketCard> & Pick<TicketCard, 'id'>): TicketCard {
  return {
    sourceId: 'files',
    title: overrides.id,
    status: 'open',
    updated: '2026-09-04',
    body: `\nBody of ${overrides.id}.\n`,
    ...overrides
  }
}

export function createMockTicketsApi(): MockTicketsApi {
  const subscribers = new Set<(projectPath: string) => void>()
  const projects = new Map<string, TicketSourceListResult>()
  const listCalls: string[] = []
  const revealCalls: Array<[string, string]> = []
  const listingFor = (projectPath: string): TicketSourceListResult => {
    const listing = projects.get(projectPath) ?? { cards: [], diagnostics: [] }
    projects.set(projectPath, listing)
    return listing
  }

  return {
    projects,
    listCalls,
    revealCalls,
    publishChange(projectPath) {
      for (const subscriber of subscribers) subscriber(projectPath)
    },
    list: vi.fn(async (projectPath: string) => {
      listCalls.push(projectPath)
      const listing = listingFor(projectPath)
      return { cards: listing.cards.map((card) => ({ ...card })), diagnostics: [...listing.diagnostics] }
    }),
    setStatus: vi.fn(async (projectPath: string, slug: string, status: string) => {
      const listing = listingFor(projectPath)
      const card = listing.cards.find((candidate) => candidate.id === slug)
      if (!card) return { ok: false as const, code: 'missing-ticket', message: 'No such ticket.' }
      card.status = status
      return { ok: true as const, card: { ...card } }
    }),
    revealInFolder: vi.fn((projectPath: string, slug: string) => void revealCalls.push([projectPath, slug])),
    onChange: (callback) => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    }
  }
}
