import { vi } from 'vitest'
import type {
  TicketCard,
  TicketFilesApi,
  TicketGithubApi,
  TicketGithubListResult,
  TicketSourceAvailability,
  TicketSourceListResult
} from '../../src/shared/ticket-source'

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
  removeCalls: Array<[string, string]>
  /** Whether the project is a git checkout, which is all the delete confirmation asks about. */
  setGitRepository(repository: boolean): void
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
  const removeCalls: Array<[string, string]> = []
  let gitRepository = true
  const listingFor = (projectPath: string): TicketSourceListResult => {
    const listing = projects.get(projectPath) ?? { cards: [], diagnostics: [] }
    projects.set(projectPath, listing)
    return listing
  }

  return {
    projects,
    listCalls,
    revealCalls,
    removeCalls,
    setGitRepository: (repository) => void (gitRepository = repository),
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
    remove: vi.fn(async (projectPath: string, slug: string) => {
      removeCalls.push([projectPath, slug])
      const listing = listingFor(projectPath)
      listing.cards = listing.cards.filter((candidate) => candidate.id !== slug)
      return { ok: true as const }
    }),
    isGitRepository: vi.fn(async () => gitRepository),
    revealInFolder: vi.fn((projectPath: string, slug: string) => void revealCalls.push([projectPath, slug])),
    onChange: (callback) => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    }
  }
}

/**
 * The GitHub source as the preload bridge exposes it. Availability and the listing are held apart
 * because that is the pair the board has to keep straight: a repository whose issues it may offer,
 * and the issues themselves, which it only asks for once the user has switched the source on.
 */
export interface MockGithubIssuesApi extends TicketGithubApi {
  setAvailability(result: TicketSourceAvailability): void
  setListing(result: TicketGithubListResult): void
  listCalls: string[]
}

export function createMockGithubIssuesApi(): MockGithubIssuesApi {
  let availability: TicketSourceAvailability = { available: false, reason: 'This project has no GitHub remote.' }
  let listing: TicketGithubListResult = { available: true, cards: [], diagnostics: [] }
  const listCalls: string[] = []
  return {
    listCalls,
    setAvailability: (result) => void (availability = result),
    setListing: (result) => void (listing = result),
    availability: vi.fn(async () => availability),
    list: vi.fn(async (projectPath: string) => {
      listCalls.push(projectPath)
      return listing
    })
  }
}
