import type { BackgroundWork } from './acp-session-manager'

/**
 * Closing Toucan, or restarting it into an update, kills every agent session it hosts - and with
 * them whatever a session still had running in the background (a dev server, a watcher, a
 * sub-agent) and any turn in flight. Neither is visible from the window the user just closed, so
 * the decision to warn is made here, once, for both exits.
 *
 * `describeQuitRisk` is the pure half (what is at stake, how it reads); `createQuitGuard` owns the
 * one piece of state that matters - a user who already said "proceed" must not be asked again by
 * the second half of the same exit (an update's restart quits the app, which closes the window,
 * which quits the app).
 */

export type QuitReason = 'quit' | 'update'

export interface QuitSession {
  /** What the user knows the session as: its canvas label, never the node id unless nothing else exists. */
  name: string
  /** Background tasks it has running; 0 for a session that is only mid-turn. */
  tasks: number
}

export interface QuitActivity {
  /** Sessions with background tasks running. */
  background: QuitSession[]
  /** Sessions that are mid-turn, background tasks or not. */
  working: QuitSession[]
}

export interface QuitWarning {
  title: string
  message: string
  detail: string
  /** Label of the button that goes ahead; the other choice is always Cancel. */
  proceedLabel: string
}

const MAX_NAMED = 5

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function nameList(sessions: readonly QuitSession[]): string {
  const named = sessions.slice(0, MAX_NAMED).map((session) => `• ${session.name}`)
  if (sessions.length > MAX_NAMED) named.push(`• and ${sessions.length - MAX_NAMED} more`)
  return named.join('\n')
}

/**
 * Joins the main-side facts into the shape the dialog reads. `labelFor` turns a canvas node id into
 * what the user sees; a node the canvas no longer has falls back to its short id.
 */
export function collectQuitActivity(
  background: readonly BackgroundWork[],
  workingIds: readonly string[],
  labelFor: (nodeId: string) => string | undefined
): QuitActivity {
  const name = (id: string): string => labelFor(id)?.trim() || id.slice(0, 8)
  const tasksOf = new Map(background.map((work) => [work.id, work.tasks]))
  return {
    background: background.map((work) => ({ name: name(work.id), tasks: work.tasks })),
    working: workingIds.map((id) => ({ name: name(id), tasks: tasksOf.get(id) ?? 0 }))
  }
}

/** Total background tasks across sessions, as the dialog's headline quotes it. */
export function backgroundTaskTotal(background: readonly QuitSession[]): number {
  return background.reduce((sum, session) => sum + session.tasks, 0)
}

/** Null when closing now costs nothing; otherwise what the user should be told first. */
export function describeQuitRisk(activity: QuitActivity, reason: QuitReason): QuitWarning | null {
  const { background, working } = activity
  if (background.length === 0 && working.length === 0) return null

  const parts: string[] = []
  if (background.length > 0) {
    const tasks = backgroundTaskTotal(background)
    parts.push(`${plural(tasks, 'background task')} still running in ${plural(background.length, 'session')}`)
  }
  if (working.length > 0) parts.push(`${plural(working.length, 'session')} in the middle of a turn`)

  const lines: string[] = []
  if (background.length > 0) lines.push(`Background tasks:\n${nameList(background)}`)
  // A session with background tasks that is also mid-turn is already listed above.
  const workingOnly = working.filter((session) => session.tasks === 0)
  if (workingOnly.length > 0) lines.push(`Working:\n${nameList(workingOnly)}`)

  const consequence =
    reason === 'update'
      ? 'Restarting to install the update stops them.'
      : 'Closing Toucan stops them, and nothing resumes them when it opens again.'

  return {
    title: reason === 'update' ? 'Restart to update?' : 'Quit Toucan?',
    message: `${parts.join(' and ')}.`,
    detail: `${consequence}\n\n${lines.join('\n\n')}`,
    proceedLabel: reason === 'update' ? 'Restart anyway' : 'Quit anyway'
  }
}

export interface QuitGuard {
  /**
   * Resolves true when the exit may go ahead: nothing is at stake, or the user chose to proceed.
   * A true answer clears the exit (see `cleared`), so the rest of the same exit - an update's
   * restart quits the app, which closes the window, which quits the app - is not asked again.
   * Concurrent callers share one prompt, because a window close and an app quit can arrive together.
   */
  confirm(reason: QuitReason): Promise<boolean>
  /**
   * Whether an exit was cleared moments ago and is presumably still under way. It lapses after
   * `clearedForMs`: a restart that was cleared but never happened (the installer refused, the
   * status moved during the dialog) must not leave every later close unguarded.
   */
  cleared(): boolean
  /** Clears the exit without asking, for a shutdown the OS has already decided on. */
  allowExit(): void
  /** Forgets a cleared exit. */
  reset(): void
}

/** Long enough for an installer to spawn and every window to close; short enough to be no loophole. */
const CLEARED_FOR_MS = 15_000

export function createQuitGuard(options: {
  activity: () => Promise<QuitActivity>
  /** Shows the warning; true means the user chose to proceed. */
  ask: (warning: QuitWarning) => Promise<boolean>
  now?: () => number
  clearedForMs?: number
}): QuitGuard {
  const now = options.now ?? Date.now
  const clearedForMs = options.clearedForMs ?? CLEARED_FOR_MS
  let clearedAt: number | null = null
  let pending: Promise<boolean> | null = null

  const cleared = (): boolean => clearedAt !== null && now() - clearedAt < clearedForMs
  const clear = (): void => {
    clearedAt = now()
  }

  return {
    confirm(reason) {
      if (cleared()) return Promise.resolve(true)
      if (pending) return pending
      const decision = (async () => {
        const warning = describeQuitRisk(await options.activity(), reason)
        const proceed = warning === null || (await options.ask(warning))
        if (proceed) clear()
        return proceed
        // A failed lookup or dialog must never trap the user in a window they cannot close.
      })().catch(() => {
        clear()
        return true
      })
      pending = decision.finally(() => {
        pending = null
      })
      return pending
    },
    cleared,
    allowExit: clear,
    reset() {
      clearedAt = null
    }
  }
}
