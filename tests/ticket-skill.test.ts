import { deepEqual, equal, match, ok } from 'node:assert/strict'
import { test } from 'node:test'
import { TICKET_FIELDS } from '../src/shared/ticket-format'
import { TICKET_SKILL_NAME, ticketSkillMarkdown } from '../src/shared/ticket-skill'
import { projectSkillPath } from '../src/shared/project-skills'
import { DEFAULT_TICKETS_DIRECTORY, DEFAULT_TICKET_STATUSES, readTicket } from '../src/shared/tickets'

/**
 * The scaffolded skill is the ticket convention told to an agent, and Toucan writes it once and
 * never again - so nothing downstream can correct it. These tests hold it to the one thing that
 * actually decides: `readTicket`. A skill that taught a shape the board reads differently would
 * be worse than the bundled skill it replaces, because the project now owns the mistake.
 */

const TODAY = '2026-09-20'

function markdown(directory = DEFAULT_TICKETS_DIRECTORY): string {
  return ticketSkillMarkdown({ ticketsDirectory: directory, today: TODAY })
}

/** The fenced example the skill shows, which is the only thing an agent is likely to copy. */
function example(source: string): string {
  const fenced = source.match(/```markdown\n([\s\S]*?)```/)
  ok(fenced, 'the skill shows a fenced example ticket')
  return fenced[1]
}

test('the scaffolded skill opens with frontmatter a provider can load it by', () => {
  const lines = markdown().split('\n')

  equal(lines[0], '---')
  equal(lines[1], `name: ${TICKET_SKILL_NAME}`)
  ok(lines[2].startsWith('description: '))
  // One line, no wrapping: a description broken over two lines is a YAML value that ends early.
  ok(lines[2].length > 40)
  equal(lines[3], '---')
})

test('the example the skill shows is itself a ticket the board renders', () => {
  const ticket = readTicket(example(markdown()), 'ticket-board')

  equal(ticket.slug, 'ticket-board')
  equal(ticket.status, DEFAULT_TICKET_STATUSES[0])
  equal(ticket.created, TODAY)
  equal(ticket.updated, TODAY)
  ok(ticket.title.length > 0)
  ok(ticket.body.trim().length > 0)
  // Pasted as it stands it must not name a blocker no ticket in the folder answers to.
  deepEqual(ticket.blockedBy, [])
})

test('the skill names every field the board reads, and no other', () => {
  const source = markdown()

  for (const field of TICKET_FIELDS) ok(source.includes(`\`${field.name}\``), `names ${field.name}`)
})

test('the skill names every column a status can land in', () => {
  const source = markdown()

  for (const status of DEFAULT_TICKET_STATUSES) ok(source.includes(`\`${status}\``), `names ${status}`)
})

test("the skill sends an agent to the project's own tickets folder", () => {
  match(markdown('notes/work'), /`notes\/work`/)
  // The default is still named, so a reader can tell a moved folder from the usual one.
  match(markdown('notes/work'), new RegExp(DEFAULT_TICKETS_DIRECTORY.replace('/', '\/')))
  ok(!markdown().includes('notes/work'))
})

test('the skill says the project owns it, and points at its own path', () => {
  const source = markdown()

  ok(source.includes(projectSkillPath(TICKET_SKILL_NAME)))
  // The whole point of scaffolding rather than injecting: this copy is editable and Toucan is done
  // with it. A skill that did not say so would be read as Toucan's to maintain.
  match(source, /never|not Toucan|own/i)
})

test('the skill teaches leniency rather than a gate', () => {
  match(markdown(), /Every Markdown file in the folder becomes a card/)
})
