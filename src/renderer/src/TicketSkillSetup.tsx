import { BookPlus } from 'lucide-react'
import type { TicketSkillOffer } from './use-ticket-skill'

/**
 * The offer to give this project its own tickets skill, and the report of what happened. It renders
 * `use-ticket-skill.ts` and decides nothing beyond wording: whether a project already has a skill
 * is answered on disk, and whether one may be replaced is answered in main.
 *
 * It is shown on the empty board, beside the primer, because the two are the same explanation told
 * to the two readers who need it - the primer tells the person what a ticket file is, this tells
 * them how to let their agents write one. The board's header carries the same action for a project
 * that already has tickets but never got the skill.
 *
 * An `unknown` project is shown nothing at all, neither the offer nor the reassurance: both are
 * claims about a file, and Toucan has not managed to look at one.
 */

/** One wording, so the empty-state button and the header control cannot come to disagree. */
export const TICKET_SKILL_ACTION = 'Set up ticket skill'

export interface TicketSkillSetupProps {
  skill: TicketSkillOffer
}

export default function TicketSkillSetup(props: TicketSkillSetupProps): JSX.Element | null {
  const { skill } = props
  if (skill.status === 'unknown') return null

  return (
    <section className="ticket-skill-setup" aria-label="Tickets skill">
      {skill.status === 'present' ? (
        <p>
          This project has its own tickets skill at <code>{skill.path}</code>, so its agents already know the
          convention. It is the project’s file — Toucan never rewrites it.
        </p>
      ) : (
        <>
          <p>
            Agents in this project have not been told any of this. Toucan can write a starter <code>{skill.path}</code>{' '}
            that teaches the shape above; the file is then the project’s, to edit and to commit.
          </p>
          <button
            type="button"
            className="ticket-skill-button"
            disabled={skill.pending}
            onClick={() => void skill.write()}
          >
            <BookPlus aria-hidden="true" />
            {skill.pending ? 'Writing the skill…' : TICKET_SKILL_ACTION}
          </button>
        </>
      )}

      {skill.outcome && (
        <p className="ticket-skill-outcome" role={skill.outcome.ok ? 'status' : 'alert'}>
          {skill.outcome.ok ? `Wrote ${skill.outcome.path}. Commit it with the project.` : skill.outcome.message}
          <button type="button" onClick={skill.reveal}>
            Show the file
          </button>
          <button type="button" onClick={skill.dismiss}>
            Dismiss
          </button>
        </p>
      )}
    </section>
  )
}

/** The same action as one header control, for a board that has tickets but no skill to write them. */
export function TicketSkillHeaderButton(props: TicketSkillSetupProps): JSX.Element | null {
  const { skill } = props
  if (skill.status !== 'absent') return null
  return (
    <button
      type="button"
      className="ticket-board-button"
      aria-label={skill.pending ? 'Writing the tickets skill…' : TICKET_SKILL_ACTION}
      title={`Write a starter ${skill.path} so this project’s agents know its ticket convention`}
      disabled={skill.pending}
      onClick={() => void skill.write()}
    >
      <BookPlus aria-hidden="true" />
    </button>
  )
}
