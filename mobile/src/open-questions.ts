import type { RemoteChatSummary } from '../../src/shared/remote-access'
import type { OrchestrationOpenQuestion } from '../../src/shared/ticket-session-spawn'

/**
 * What the questions view and the close confirmation decide, without a DOM.
 */

/**
 * The questions still to show: the host's list minus the ones this reader just resolved. A resolve
 * is only reflected by the next workspace read, so without this an answered tab would linger for
 * up to a poll and invite a second press.
 */
export function visibleQuestions(
  questions: readonly OrchestrationOpenQuestion[],
  resolved: ReadonlySet<string>
): OrchestrationOpenQuestion[] {
  return questions.filter((question) => !resolved.has(question.id))
}

/**
 * The tab to show: the one picked while it is still open, else the oldest. A resolved or vanished
 * pick therefore falls to the oldest question left rather than to an empty panel.
 */
export function selectedQuestion(
  questions: readonly OrchestrationOpenQuestion[],
  picked: string | null
): OrchestrationOpenQuestion | undefined {
  return questions.find((question) => question.id === picked) ?? questions[0]
}

/** A tab's label: the question id, and the ticket it is about when it names one. */
export function questionTabLabel(question: OrchestrationOpenQuestion): string {
  return question.ticketId === undefined ? question.id : `${question.id} · #${question.ticketId}`
}

/**
 * The branches of the ticket worktrees an orchestrator owns, in list order - what closing it
 * leaves behind with nothing to merge or clean them up. Read off the same `orchestratorId` link the
 * chat list nests ticket sessions by, so the warning names exactly the rows shown under it.
 */
export function orchestratorTicketWorktrees(chats: readonly RemoteChatSummary[], orchestratorId: string): string[] {
  const branches: string[] = []
  for (const chat of chats) {
    if (chat.id === orchestratorId || chat.orchestratorId !== orchestratorId || !chat.worktree) continue
    if (!branches.includes(chat.worktree)) branches.push(chat.worktree)
  }
  return branches
}
