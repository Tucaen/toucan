import type { TicketGithubApi, TicketSource, TicketSourceListResult } from '../../shared/ticket-source'
import { TICKET_GITHUB_SOURCE_ID } from '../../shared/github-issues'

/**
 * The optional source: the project's GitHub issues, reached through the preload bridge. Like the
 * files source it is a thin adapter, with one job of its own - remembering each card's issue URL,
 * so `openExternal` can send the user to the issue when the seam only hands it a card id.
 *
 * It has no `setStatus` and no `onChange`, and both absences are the feature: a column refuses a
 * drop for its cards because a status here would be a label mapping nobody has agreed yet, and the
 * board never polls GitHub - it re-lists when opened, when a project changes, and when asked.
 */
export function createTicketGithubSource(api: TicketGithubApi, openUrl: (url: string) => void): TicketSource {
  /** Per project, the last listing's issue URLs by card id. */
  const urls = new Map<string, Map<string, string>>()

  return {
    id: TICKET_GITHUB_SOURCE_ID,
    label: 'GitHub',
    availability: (projectPath) => api.availability(projectPath),
    async list(projectPath): Promise<TicketSourceListResult> {
      const result = await api.list(projectPath)
      if (!result.available) {
        // The user switched this source on, so the reason belongs on the board rather than in a
        // silently empty column - the same posture as a ticket file that cannot be parsed.
        return {
          cards: [],
          diagnostics: [{ path: 'GitHub', code: 'github-unavailable', message: result.reason }]
        }
      }
      urls.set(
        projectPath,
        new Map(result.cards.filter((card) => card.url).map((card) => [card.id, card.url as string]))
      )
      return { cards: result.cards, diagnostics: result.diagnostics }
    },
    openExternal(projectPath, cardId) {
      const url = urls.get(projectPath)?.get(cardId)
      if (url) openUrl(url)
    }
  }
}
