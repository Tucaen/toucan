import {
  TICKET_FIELDS,
  TICKET_FORMAT_BLOCKED_BY,
  TICKET_FORMAT_DONE_COLUMN,
  TICKET_FORMAT_FILENAME,
  TICKET_FORMAT_FRONTMATTER,
  TICKET_FORMAT_UNKNOWN_STATUS,
  exampleTicketMarkdown,
  ticketLocationNote
} from '../../shared/ticket-format'
import { DEFAULT_TICKET_STATUSES } from '../../shared/tickets'
import { ticketStatusLabel } from './ticket-board'

/**
 * The ticket file convention, rendered for a human. Until this existed the shape was taught only
 * to agents (the `tickets` skill) and to code (the parser), so the one person who has to create
 * the first file - on a board showing four empty columns - was the one nobody told.
 *
 * It renders `shared/ticket-format.ts` and decides nothing: the fields, the example and the prose
 * all come from there, and the column names are run through the board's own `ticketStatusLabel`,
 * so what the primer promises a status will be called is what the board will call it. The tickets
 * folder arrives already resolved, because resolving it is the workspace's job and not a second
 * opinion taken here.
 */

export interface TicketFormatPrimerProps {
  /** The project's tickets folder relative to its checkout, already resolved against the default. */
  ticketsDirectory: string
  /** Today as `YYYY-MM-DD`, so the example can be copied into the folder as it stands. */
  today: string
}

export default function TicketFormatPrimer(props: TicketFormatPrimerProps): JSX.Element {
  return (
    <section className="ticket-format-primer" aria-label="Ticket file format">
      <p>
        {ticketLocationNote(props.ticketsDirectory).map((segment, index) =>
          'path' in segment ? <code key={index}>{segment.path}</code> : <span key={index}>{segment.text}</span>
        )}
      </p>
      <p>{TICKET_FORMAT_FILENAME}</p>
      <p>{TICKET_FORMAT_FRONTMATTER}</p>

      <pre className="ticket-format-example">
        <code>{exampleTicketMarkdown(props.today)}</code>
      </pre>

      <dl className="ticket-format-fields">
        {TICKET_FIELDS.map((field) => (
          <div key={field.name}>
            <dt>
              <code>{field.name}</code>
            </dt>
            <dd>
              <span className="ticket-format-requirement">{field.required ? 'Required.' : 'Optional.'}</span>{' '}
              {field.summary} {field.whenAbsent}
            </dd>
          </div>
        ))}
      </dl>

      <p>
        {'A ticket’s status is its column: '}
        {DEFAULT_TICKET_STATUSES.map((status, index) => (
          <span key={status}>
            {index > 0 && ', '}
            <code>{status}</code>
            {' is '}
            <code>{ticketStatusLabel(status)}</code>
          </span>
        ))}
        {`. ${TICKET_FORMAT_UNKNOWN_STATUS} ${TICKET_FORMAT_DONE_COLUMN}`}
      </p>
      <p>{TICKET_FORMAT_BLOCKED_BY}</p>
    </section>
  )
}
