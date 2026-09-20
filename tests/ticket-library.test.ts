import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

test('list projects every direct .md child onto a card, however little the file says', async () => {
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
    await writeFile(join(folder, 'no-frontmatter.md'), '# A hand-written note\n\nJust prose.\n', 'utf8')
    await writeFile(join(folder, 'notes.txt'), 'ignored', 'utf8')
    await mkdir(join(folder, 'subfolder'), { recursive: true })

    const { cards, diagnostics } = await library().list(project)
    assert.deepEqual(diagnostics, [])
    assert.deepEqual(
      // `orderedAt` is an mtime, so it is asserted below rather than matched against a constant.
      cards.map(({ orderedAt: _orderedAt, ...card }) => card),
      [
        {
          sourceId: 'files',
          id: 'no-frontmatter',
          title: 'A hand-written note',
          status: 'open',
          body: '# A hand-written note\n\nJust prose.\n'
        },
        {
          sourceId: 'files',
          id: 'ticket-board',
          title: 'Ticket board panel',
          status: 'in-progress',
          updated: '2026-09-03',
          blockedBy: ['shared-frontmatter'],
          body: '\nThe body.\n'
        }
      ]
    )
    // The note has no date to show, so it carries the file's own mtime for the board to order by.
    assert.equal(cards[0].updated, undefined)
    assert.ok((cards[0].orderedAt ?? 0) > 0)
  })
})

test('a filename that is not a slug is the one thing that keeps a file off the board', async () => {
  await withProject(async (project, folder) => {
    await writeFile(
      join(folder, 'Broken Name.md'),
      ticketFile({ title: 'x', status: 'open', created: TODAY, updated: TODAY }),
      'utf8'
    )

    const { cards, diagnostics } = await library().list(project)
    assert.deepEqual(cards, [])
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].code, 'unusable-filename')
    assert.match(diagnostics[0].message, /kebab-case/)
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

test('a note with no frontmatter can be dropped into a column: the block is written above it', async () => {
  await withProject(async (project, folder) => {
    await writeFile(join(folder, 'flaky-test.md'), '# Flaky test\n\nFails on Windows only.\n', 'utf8')

    const result = await library().setStatus(project, 'flaky-test', 'done')

    assert.equal(result.ok, true)
    assert.deepEqual(result.ok && result.card, {
      sourceId: 'files',
      id: 'flaky-test',
      title: 'Flaky test',
      status: 'done',
      updated: TODAY,
      body: '\n# Flaky test\n\nFails on Windows only.\n'
    })
    // The prose is kept verbatim below the block; nothing is invented but the two fields written.
    assert.equal(
      await readFile(join(folder, 'flaky-test.md'), 'utf8'),
      `---\nstatus: done\nupdated: ${TODAY}\n---\n\n# Flaky test\n\nFails on Windows only.\n`
    )
  })
})

test('a frontmatter line Toucan cannot read survives the status write beside the fields it did', async () => {
  await withProject(async (project, folder) => {
    const original = '---\ntitle: Board\nthis line is not a field\nstatus: open\n---\n\nBody.\n'
    await writeFile(join(folder, 'ticket-board.md'), original, 'utf8')

    const result = await library().setStatus(project, 'ticket-board', 'done')

    assert.equal(result.ok, true)
    assert.equal(
      await readFile(join(folder, 'ticket-board.md'), 'utf8'),
      `---\ntitle: Board\nthis line is not a field\nstatus: done\nupdated: ${TODAY}\n---\n\nBody.\n`
    )
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

test('one ticket reads fresh from its file, a missing one is null, a bare note is still a ticket', async () => {
  await withProject(async (project, folder) => {
    await writeFile(
      join(folder, 'ticket-board.md'),
      ticketFile({ title: 'Ticket board', status: 'open', created: TODAY, updated: TODAY }, 'Body.\n'),
      'utf8'
    )
    await writeFile(join(folder, 'bare.md'), 'no frontmatter\n', 'utf8')
    const store = library()

    const ticket = await store.read(project, 'ticket-board')
    assert.equal(ticket?.title, 'Ticket board')
    assert.equal(ticket?.body, '\nBody.\n')
    assert.equal(await store.read(project, 'never-written'), null)
    assert.equal(await store.read(project, '../escape'), null)
    // No throw and no null: the file says nothing, so the ticket falls back to what it can.
    assert.equal((await store.read(project, 'bare'))?.title, 'bare')
  })
})

test('a body edited outside Toucan between a listing and a drop survives the status write intact', async () => {
  await withProject(async (project, folder) => {
    const path = join(folder, 'ticket-board.md')
    await writeFile(
      path,
      ticketFile({ title: 'Ticket board', status: 'open', created: '2026-09-01', updated: '2026-09-01' }, 'Old.\n'),
      'utf8'
    )
    const store = library()
    await store.list(project)

    // The editor saves after the board listed and before the user drops: the write must read the
    // file as it is now, not as the board last saw it.
    const edited = '# Rewritten\n\nBy hand, with  odd   spacing.\n'
    await writeFile(
      path,
      ticketFile({ title: 'Ticket board', status: 'open', created: '2026-09-01', updated: '2026-09-01' }, edited),
      'utf8'
    )
    const result = await store.setStatus(project, 'ticket-board', 'done')
    assert.equal(result.ok, true)

    const written = await readFile(path, 'utf8')
    assert.equal(
      written,
      `---\ntitle: Ticket board\nstatus: done\ncreated: 2026-09-01\nupdated: ${TODAY}\n---\n\n${edited}`
    )
    // Promoted through a temporary file: nothing but the ticket is left in the folder.
    assert.deepEqual(await readdir(folder), ['ticket-board.md'])
  })
})

test('the file behind a card can be located for the shell to reveal', async () => {
  await withProject(async (project, folder) => {
    assert.equal(await library().pathFor(project, 'ticket-board'), join(folder, 'ticket-board.md'))
    assert.equal(await library().pathFor(project, '../escape'), null)
  })
})

test('removing a ticket deletes its file and takes it out of the listing', async () => {
  await withProject(async (project, folder) => {
    await writeFile(
      join(folder, 'ticket-board.md'),
      ticketFile({ title: 'Board', status: 'done', created: '2026-08-01', updated: '2026-08-01' }),
      'utf8'
    )
    await writeFile(
      join(folder, 'ticket-delete.md'),
      ticketFile({ title: 'Delete', status: 'open', created: TODAY, updated: TODAY, blocked_by: 'ticket-board' }),
      'utf8'
    )
    const store = library()

    assert.deepEqual(await store.remove(project, 'ticket-board'), { ok: true })
    await assert.rejects(readFile(join(folder, 'ticket-board.md'), 'utf8'))

    // The blocker it left behind is the board's existing "missing" chip, not a third state.
    const { cards, diagnostics } = await store.list(project)
    assert.deepEqual(
      cards.map((card) => card.id),
      ['ticket-delete']
    )
    assert.deepEqual(cards[0].blockedBy, ['ticket-board'])
    assert.deepEqual(diagnostics, [])
  })
})

test('removing refuses anything that is not a slug in the tickets folder', async () => {
  await withProject(async (project, folder) => {
    const outside = join(project, 'secrets.md')
    await writeFile(outside, 'not a ticket\n', 'utf8')
    await writeFile(
      join(folder, 'ticket-board.md'),
      ticketFile({ title: 'Board', status: 'open', created: TODAY, updated: TODAY }),
      'utf8'
    )
    const store = library()

    for (const rejected of ['../secrets', 'sub/ticket-board', '..', '', 'Ticket-Board']) {
      const result = await store.remove(project, rejected)
      assert.equal(result.ok, false)
      assert.equal(result.ok === false && result.code, 'invalid-slug')
    }
    assert.equal(await readFile(outside, 'utf8'), 'not a ticket\n')
    assert.equal((await store.list(project)).cards.length, 1)
  })
})

test('removing a ticket that is already gone is the outcome the caller asked for', async () => {
  await withProject(async (project) => {
    assert.deepEqual(await library().remove(project, 'never-written'), { ok: true })
  })
})
