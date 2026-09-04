import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTicketLibrary } from '../src/main/ticket-library'
import { DEFAULT_TICKETS_DIRECTORY } from '../src/shared/tickets'

const TODAY = '2026-09-04'

function ticketFile(fields: Record<string, string>, body = 'The body.\n'): string {
  const block = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return `---\n${block}\n---\n\n${body}`
}

async function withProject(run: (project: string, folder: string) => Promise<void>): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), 'toucan-tickets-'))
  const folder = join(project, DEFAULT_TICKETS_DIRECTORY)
  await mkdir(folder, { recursive: true })
  try {
    await run(project, folder)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

function library(): ReturnType<typeof createTicketLibrary> {
  return createTicketLibrary({
    directoryFor: (projectPath) => join(projectPath, DEFAULT_TICKETS_DIRECTORY),
    today: () => TODAY
  })
}

test('a project without a tickets folder lists as empty rather than failing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'toucan-tickets-'))
  try {
    assert.deepEqual(await library().list(project), { cards: [], diagnostics: [] })
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test('list projects each conforming file onto a card and reports the rest as diagnostics', async () => {
  await withProject(async (project, folder) => {
    await writeFile(
      join(folder, 'ticket-board.md'),
      ticketFile({
        title: 'Ticket board panel',
        status: 'in-progress',
        created: '2026-09-01',
        updated: '2026-09-03',
        blocked_by: 'shared-frontmatter, shared-frontmatter'
      }),
      'utf8'
    )
    await writeFile(
      join(folder, 'Broken Name.md'),
      ticketFile({ title: 'x', status: 'open', created: TODAY, updated: TODAY }),
      'utf8'
    )
    await writeFile(join(folder, 'no-frontmatter.md'), 'Just prose.\n', 'utf8')
    await writeFile(join(folder, 'notes.txt'), 'ignored', 'utf8')
    await mkdir(join(folder, 'subfolder'), { recursive: true })

    const { cards, diagnostics } = await library().list(project)
    assert.deepEqual(cards, [
      {
        sourceId: 'files',
        id: 'ticket-board',
        title: 'Ticket board panel',
        status: 'in-progress',
        updated: '2026-09-03',
        blockedBy: ['shared-frontmatter'],
        body: '\nThe body.\n'
      }
    ])
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.path.endsWith('Broken Name.md')),
      [true, false]
    )
    assert.match(diagnostics[0].message, /kebab-case/)
    assert.match(diagnostics[1].message, /frontmatter/)
    assert.equal(diagnostics[0].code, 'malformed-ticket')
  })
})

test('setting a status rewrites only the frontmatter and stamps the day it happened', async () => {
  await withProject(async (project, folder) => {
    const body = '# Heading\n\n-   deliberately   ragged   prose\n\n\ntrailing\n'
    await writeFile(
      join(folder, 'ticket-board.md'),
      ticketFile({ title: 'Ticket board', status: 'open', created: '2026-09-01', updated: '2026-09-01' }, body),
      'utf8'
    )

    const result = await library().setStatus(project, 'ticket-board', 'done')
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok && result.card, {
      sourceId: 'files',
      id: 'ticket-board',
      title: 'Ticket board',
      status: 'done',
      updated: TODAY,
      body: `\n${body}`
    })
    const written = await readFile(join(folder, 'ticket-board.md'), 'utf8')
    assert.equal(
      written,
      `---\ntitle: Ticket board\nstatus: done\ncreated: 2026-09-01\nupdated: ${TODAY}\n---\n\n${body}`
    )
  })
})

test('a status a project invented is written, an unusable one is refused', async () => {
  await withProject(async (project, folder) => {
    const original = ticketFile({ title: 'T', status: 'open', created: TODAY, updated: TODAY })
    await writeFile(join(folder, 'ticket-board.md'), original, 'utf8')
    const store = library()

    assert.equal((await store.setStatus(project, 'ticket-board', 'review')).ok, true)
    for (const rejected of ['', 'In Review', 'done extra', '../escape']) {
      const result = await store.setStatus(project, 'ticket-board', rejected)
      assert.equal(result.ok, false)
      assert.equal(result.ok === false && result.code, 'invalid-status')
    }
    assert.equal((await store.setStatus(project, '../outside', 'done')).ok, false)
    assert.equal((await store.setStatus(project, 'never-written', 'done')).ok, false)
  })
})

test('a file edited into nonsense outside Toucan is refused, not rewritten', async () => {
  await withProject(async (project, folder) => {
    await writeFile(join(folder, 'ticket-board.md'), 'no frontmatter at all\n', 'utf8')
    const result = await library().setStatus(project, 'ticket-board', 'done')
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.code, 'malformed-source')
    assert.equal(await readFile(join(folder, 'ticket-board.md'), 'utf8'), 'no frontmatter at all\n')
  })
})

test('a write leaves no temporary file behind for the next listing to trip over', async () => {
  await withProject(async (project, folder) => {
    await writeFile(
      join(folder, 'ticket-board.md'),
      ticketFile({ title: 'T', status: 'open', created: TODAY, updated: TODAY }),
      'utf8'
    )
    await library().setStatus(project, 'ticket-board', 'done')
    const { cards, diagnostics } = await library().list(project)
    assert.equal(cards.length, 1)
    assert.deepEqual(diagnostics, [])
  })
})

test('the file behind a card can be located for the shell to reveal', async () => {
  await withProject(async (project, folder) => {
    assert.equal(await library().pathFor(project, 'ticket-board'), join(folder, 'ticket-board.md'))
    assert.equal(await library().pathFor(project, '../escape'), null)
  })
})
