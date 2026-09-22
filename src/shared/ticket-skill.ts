import { projectSkillPath } from './project-skills'
import {
  TICKET_FIELDS,
  TICKET_FORMAT_BLOCKED_BY,
  TICKET_FORMAT_DONE_COLUMN,
  TICKET_FORMAT_FILENAME,
  TICKET_FORMAT_FRONTMATTER,
  TICKET_FORMAT_LENIENCE,
  TICKET_FORMAT_UNKNOWN_STATUS,
  exampleTicketMarkdown,
  ticketLocationNote
} from './ticket-format'
import { DEFAULT_TICKET_STATUSES, TICKET_STATUS } from './tickets'

/**
 * The ticket convention as a skill *a project owns*. Toucan writes this file once into the
 * project's own `.agents/skills/` and then has nothing more to do with it: the project commits it,
 * edits it, and is free to teach a convention of its own. That is the trade this module exists to
 * make - a project gets a working starting point without inheriting a shape Toucan dictates from
 * outside and keeps rewriting underneath it.
 *
 * Because Toucan never writes it again, nothing downstream can correct it, so every claim it makes
 * about the file shape is taken from `ticket-format.ts` rather than said a second time here. What
 * *is* written here is the part no other surface carries: how to work on tickets, which is advice
 * to an agent rather than a property of the file format. `tests/ticket-skill.test.ts` holds the
 * example it shows against `readTicket` itself.
 *
 * Pure: it builds a string. Writing it to a checkout is `main/ticket-skill-scaffold.ts`.
 */

/**
 * The skill's name, which is also its directory and how an agent invokes it.
 * @internal exported for tests
 */
export const TICKET_SKILL_NAME = 'tickets'

/** Where the scaffolded skill lands, relative to the project checkout, with forward slashes. */
export const TICKET_SKILL_PATH = projectSkillPath(TICKET_SKILL_NAME)

const DESCRIPTION =
  "Create and update this project's Markdown tickets. Use when the user asks for a ticket, when work needs " +
  "tracking and no issue tracker is reachable, or when a ticket's status, blockers or scope changed."

export interface TicketSkillMarkdownOptions {
  /** The project's tickets folder relative to its checkout, already resolved against the default. */
  ticketsDirectory: string
  /** Today as `YYYY-MM-DD`, so the example can be copied into the folder as it stands. */
  today: string
}

/** The location sentence as Markdown, with the folder names set as code. */
function locationParagraph(directory: string): string {
  return ticketLocationNote(directory)
    .map((segment) => ('path' in segment ? '`' + segment.path + '`' : segment.text))
    .join('')
}

function fieldList(): string {
  return TICKET_FIELDS.map(
    (field) =>
      `- \`${field.name}\` — ${field.expected ? 'Write it.' : 'Optional.'} ${field.summary} ${field.whenAbsent}`
  ).join('\n')
}

function statusSentence(): string {
  const columns = DEFAULT_TICKET_STATUSES.map((status) => `\`${status}\``).join(', ')
  return `A ticket's status is its column, and Toucan ships ${columns}. ${TICKET_FORMAT_UNKNOWN_STATUS} ${TICKET_FORMAT_DONE_COLUMN}`
}

export function ticketSkillMarkdown(options: TicketSkillMarkdownOptions): string {
  return [
    '---',
    `name: ${TICKET_SKILL_NAME}`,
    `description: ${DESCRIPTION}`,
    '---',
    '',
    '# Tickets',
    '',
    "A ticket is one Markdown file in this project's tickets folder, and **the file is the truth**. Toucan's board",
    'renders and mutates those files and keeps no second copy of ticket state, so a change you make is the change',
    'everyone sees.',
    '',
    `This skill is **this project's**, not Toucan's: \`${TICKET_SKILL_PATH}\` was scaffolded once and Toucan will`,
    'never rewrite it. Edit it to say how this project actually works, and commit it with the code. Where the',
    'project has an issue tracker the user already works in, file the work there instead and say so; do not',
    'mirror tracker issues into files.',
    '',
    '## Where the files live',
    '',
    locationParagraph(options.ticketsDirectory),
    '',
    TICKET_FORMAT_FILENAME,
    '',
    '## File shape',
    '',
    '```markdown',
    exampleTicketMarkdown(options.today).trimEnd(),
    '```',
    '',
    TICKET_FORMAT_FRONTMATTER,
    '',
    TICKET_FORMAT_LENIENCE,
    '',
    "Dates are `YYYY-MM-DD`, and never invented: read today's date from the environment. An undated ticket is",
    'ordered by when its file last changed and shows no date at all, which is the honest outcome — a wrong date',
    'is worse than none.',
    '',
    '## Fields',
    '',
    fieldList(),
    '',
    '## Status',
    '',
    statusSentence(),
    '',
    'Write an invented status as one lowercase kebab-case word (`review`, not `In Review`). Flip `status` when the',
    'observable state changed and bump `updated` in the same edit — a status the board shows with a stale',
    `\`updated\` is worse than either alone. Never move a ticket to \`${TICKET_STATUS.done}\` from inferred completion:`,
    `it is done when the work is merged or the user says so. Set \`${TICKET_STATUS.blocked}\` only when something`,
    'outside the ticket must happen first, and record what.',
    '',
    '## Blockers',
    '',
    TICKET_FORMAT_BLOCKED_BY,
    '',
    'Do not list a ticket as blocking itself, and drop a slug once its ticket is done.',
    '',
    '## Working on tickets',
    '',
    '- Read every direct `.md` child of the folder before creating a ticket: extend the ticket that already',
    '  covers the work rather than opening a near-duplicate.',
    '- One ticket is one slice of work someone can pick up and finish. Split a request with two independent',
    '  outcomes; do not split one change into a file per file it touches.',
    '- Editing a ticket means rewriting the body to the current understanding, not appending a log. Keep the',
    '  decisions and constraints; drop the superseded speculation.',
    '- Leave a file you did not write alone unless the user asked you to change it. A note with no frontmatter is',
    '  already a card exactly as it stands, and "fixing" it into the shape above rewrites whatever the human',
    '  meant.',
    '',
    '## Completion',
    '',
    'Report which slugs you created, updated and closed, and nothing else:',
    '',
    '```text',
    'Created 2 tickets (ticket-board, live-session-cards). Updated 1 (shared-frontmatter → done).',
    '```',
    ''
  ].join('\n')
}

/**
 * Where a project stands on having its own tickets skill. `unknown` is a real answer and not a
 * placeholder: a checkout Toucan could not read must not be told it already has a skill, which is
 * a claim about a file, nor that it has none, which is an offer to write over one. Nothing is said
 * and nothing is offered.
 */
export type TicketSkillPresence = 'present' | 'absent' | 'unknown'

export interface TicketSkillState {
  status: TicketSkillPresence
  /** The skill file relative to the checkout, for naming it to the user. */
  path: string
}

export type TicketSkillWriteResult = { ok: true; path: string } | { ok: false; code: string; message: string }

/** The renderer-facing half of the scaffold, exposed by the preload bridge as `ticketSkillApi`. */
export interface TicketSkillApi {
  state(projectPath: string): Promise<TicketSkillState>
  /** Writes the starter skill. Refuses rather than replacing a skill the project already has. */
  write(projectPath: string): Promise<TicketSkillWriteResult>
  /** Shows the skill file in the OS file manager, so a refusal can be gone and read. */
  revealInFolder(projectPath: string): void
}
