import { DEFAULT_TICKETS_DIRECTORY, TICKET_STATUS } from './tickets'

/**
 * The ticket file convention written for someone to *read*: which frontmatter fields the board
 * takes, what it does without each of them, how a status becomes a column, and what `blocked_by`
 * means. `shared/tickets.ts` still decides how a file is read - nothing here parses anything -
 * this is only the one place that says it in words, so the board's empty-state primer and the
 * sentence a steered agent gets cannot describe two different shapes.
 *
 * What it describes is a *convention*, not a gate: the board renders every Markdown file in the
 * folder, so each field below is what a ticket should write and `whenAbsent` is what the board
 * falls back to without it. `tests/ticket-format.test.ts` checks every one of those claims
 * against `readTicket` itself, which is what keeps a fourth telling of the convention from
 * drifting into a fourth convention.
 *
 * Pure: no DOM, no filesystem, so main, renderer and the tests can all read it.
 */

export interface TicketFieldDoc {
  /** The frontmatter key, exactly as it is written in a file. */
  name: string
  /**
   * Whether a ticket written from scratch should set it. Not whether the board needs it: no
   * field is needed, and a file with no frontmatter at all still becomes a card. What an omitted
   * field costs is `whenAbsent`.
   */
  expected: boolean
  /** What the board reads this field for. */
  summary: string
  /** What the board falls back to when the field is missing, or written in a shape it cannot read. */
  whenAbsent: string
}

/** The fields the board reads, in the order a file writes them. Nothing else is looked at. */
export const TICKET_FIELDS: readonly TicketFieldDoc[] = [
  {
    name: 'title',
    expected: true,
    summary: 'The card’s heading on the board.',
    whenAbsent: 'Without it the card is headed by the body’s first heading, and failing that by the filename.'
  },
  {
    name: 'status',
    expected: true,
    summary: 'Which column the ticket sits in; one lowercase kebab-case word.',
    whenAbsent: `Without it the card sits in ${TICKET_STATUS.open}.`
  },
  {
    name: 'created',
    expected: true,
    summary: 'The day the ticket was opened, as YYYY-MM-DD.',
    whenAbsent: 'Without it, or written any other way, nothing is recorded - the board never invents a date.'
  },
  {
    name: 'updated',
    expected: true,
    summary: 'The day it last changed, as YYYY-MM-DD. Cards are ordered newest first by it.',
    whenAbsent:
      'Without it, or written any other way, the card shows no date and is ordered by when its file last changed.'
  },
  {
    name: 'blocked_by',
    expected: false,
    summary: 'Comma separated slugs of the tickets this one waits on.',
    whenAbsent: 'Absent simply means nothing is blocking it; the card shows no blocker chips.'
  }
]

/**
 * A run of prose with the folder names in it kept apart from the words around them, so a renderer
 * can set them as code without having to find them again in a finished sentence. A sentence that
 * mentioned a folder twice would defeat any such search, which is why the split happens here.
 */
export type TicketProseSegment = { text: string } | { path: string }

/**
 * Where this project's tickets go, named with the folder it actually uses rather than the default:
 * a primer that taught `docs/tickets` to a project that moved them would send someone to an empty
 * folder. Takes the resolved directory, so the caller stays the one place that resolves it.
 */
export function ticketLocationNote(directory: string): TicketProseSegment[] {
  const moved = directory !== DEFAULT_TICKETS_DIRECTORY
  return [
    { text: 'Tickets are Markdown files directly inside ' },
    { path: directory },
    { text: ' in the project, one file per ticket. ' },
    ...(moved
      ? [
          { text: "That folder is this project's own choice; " },
          { path: DEFAULT_TICKETS_DIRECTORY },
          { text: ' is the default, and a project changes it in its settings.' }
        ]
      : [
          { text: 'A project can keep them elsewhere inside the checkout by setting a tickets folder in its settings.' }
        ]),
    { text: ' Toucan never creates the folder - the first ticket written there does.' }
  ]
}

export const TICKET_FORMAT_FILENAME =
  'The filename is the ticket’s id: a lowercase kebab-case slug plus `.md`, so `ticket-board.md` is the ticket ' +
  '`ticket-board`. Only direct `.md` children count - no subfolders, no index file.'

export const TICKET_FORMAT_FRONTMATTER =
  'The file opens with frontmatter between two `---` lines: one flat `key: value` per line, no nesting, no lists ' +
  'and no quoting. Everything after the closing `---` is the body, rendered as Markdown when the ticket is open. ' +
  'A block that is opened and never closed is the one shape Toucan will not write to - moving such a card is ' +
  'refused rather than risk leaving the fields it holds stranded below a second block.'

/**
 * The leniency, said out loud. Without it the primer reads as a specification a file has to pass,
 * which is exactly the impression that made people keep notes out of the folder.
 */
export const TICKET_FORMAT_LENIENCE =
  'None of this is compulsory. Every Markdown file in the folder becomes a card, so a note with nothing but a ' +
  'heading and a paragraph is a ticket too, and each field it leaves out simply falls back to what is listed ' +
  'below. Only a filename that is not a lowercase kebab-case slug keeps a file off the board, because the ' +
  'filename is the only thing a link, a blocker or a drag has to hold on to.'

export const TICKET_FORMAT_UNKNOWN_STATUS =
  'A status that is none of these is tolerated rather than rejected: it becomes an extra column of its own, named ' +
  'after its own words.'

export const TICKET_FORMAT_DONE_COLUMN =
  'Done is collapsed to recent work; everything older is counted and offered behind “Show all”.'

export const TICKET_FORMAT_BLOCKED_BY =
  '`blocked_by` names tickets in the same folder by slug, and nothing else - a pull request or another project’s ' +
  'ticket belongs in the body as prose. Each one shows as a chip on the card: struck through once that ticket is ' +
  `\`${TICKET_STATUS.done}\`, and flagged when no ticket in the folder carries the slug, so a typo stays visible ` +
  'rather than disappearing.'

/**
 * A ticket nobody has to invent: every expected field filled in, dated today, and copyable into
 * the folder as it stands. The optional field is shown commented out rather than filled - a blocker
 * slug naming a ticket the folder does not have is exactly the flagged chip the primer warns
 * about two paragraphs down, and an example that produced one would teach the mistake.
 */
export function exampleTicketMarkdown(today: string): string {
  return [
    '---',
    'title: Short imperative title',
    `status: ${TICKET_STATUS.open}`,
    `created: ${today}`,
    `updated: ${today}`,
    '# blocked_by: another-ticket-slug',
    '---',
    '',
    'Body in ordinary Markdown: the problem, what “done” means, and any decision already made.',
    ''
  ].join('\n')
}

function backticked(fields: readonly TicketFieldDoc[]): string {
  const names = fields.map((field) => `\`${field.name}\``)
  // `Intl.ListFormat` would be the honest tool, but this string is read by an agent rather than
  // localized, and the module stays runtime-neutral by not reaching for one.
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The same field list in one sentence, for a surface with no room to lay it out - today the
 * message a session gets when it writes a file the board cannot address at all. Built from
 * `TICKET_FIELDS` rather than written again, so the two can only ever name the same fields.
 */
export const TICKET_FIELD_SENTENCE = `${backticked(TICKET_FIELDS.filter((field) => field.expected))}, and optionally ${backticked(TICKET_FIELDS.filter((field) => !field.expected))}`
