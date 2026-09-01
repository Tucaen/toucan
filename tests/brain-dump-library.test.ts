import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBrainDumpLibrary } from '../src/main/brain-dump-library'

const active = `---\ntitle: Active topic\ncreated: 2026-08-29\nupdated: 2026-08-30\nowner: me\n---\n\n# Active topic\n\nSee [[other-topic]].\n`

async function libraryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'toucan-brain-dumps-'))
}

test('missing collections are empty and listing isolates malformed topics', async () => {
  const root = await libraryRoot()
  const library = createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' })
  assert.deepEqual(await library.list('active'), { topics: [], diagnostics: [] })
  await mkdir(join(root, 'active'), { recursive: true })
  await writeFile(join(root, 'active', 'valid.md'), active)
  await writeFile(join(root, 'active', 'broken.md'), '# no frontmatter')
  await writeFile(join(root, 'active', 'ignored.txt'), active)
  const result = await library.list('active')
  assert.deepEqual(
    result.topics.map(({ slug }) => slug),
    ['valid']
  )
  assert.equal(result.diagnostics.length, 1)
  assert.match(result.diagnostics[0].message, /frontmatter/i)
})

test('listing is deterministic by updated descending then title and validates collection fields', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  await writeFile(join(root, 'active', 'zulu.md'), active.replace('Active topic', 'Zulu'))
  await writeFile(join(root, 'active', 'alpha.md'), active.replace('Active topic', 'Alpha'))
  await writeFile(join(root, 'active', 'newest.md'), active.replace('updated: 2026-08-30', 'updated: 2026-08-31'))
  const result = await createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' }).list('active')
  assert.deepEqual(
    result.topics.map(({ slug }) => slug),
    ['newest', 'alpha', 'zulu']
  )
})

test('topics expose optional absolute project paths without requiring the project to exist', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  await writeFile(
    join(root, 'active', 'assigned.md'),
    active.replace('owner: me', 'project: "D:\\\\Development\\\\Missing"')
  )
  await writeFile(join(root, 'active', 'unassigned.md'), active)
  const result = await createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' }).list('active')
  assert.equal(result.diagnostics.length, 0)
  assert.equal(result.topics.find(({ slug }) => slug === 'assigned')?.projectPath, 'D:\\Development\\Missing')
  assert.equal(result.topics.find(({ slug }) => slug === 'unassigned')?.projectPath, undefined)
})

test('topics reject malformed or non-absolute project paths', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  await writeFile(join(root, 'active', 'relative.md'), active.replace('owner: me', 'project: "projects/Toucan"'))
  await writeFile(
    join(root, 'active', 'malformed.md'),
    active.replace('owner: me', 'project: "D:\\Development\\Toucan"')
  )
  const result = await createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' }).list('active')
  assert.equal(result.topics.length, 0)
  assert.equal(result.diagnostics.length, 2)
  assert.ok(result.diagnostics.every(({ message }) => /project.*absolute|quoted.*escape/i.test(message)))
})

test('archives every supported outcome while preserving body and unknown metadata', async () => {
  for (const outcome of ['implemented', 'resolved', 'rejected', 'obsolete'] as const) {
    const root = await libraryRoot()
    await mkdir(join(root, 'active'), { recursive: true })
    await writeFile(join(root, 'active', 'active-topic.md'), active)
    const library = createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' })
    const archived = await library.archive('active-topic', outcome)
    assert.equal(archived.ok, true)
    const text = await readFile(join(root, 'archived', 'active-topic.md'), 'utf8')
    assert.match(text, new RegExp(`outcome: ${outcome}`))
    assert.match(text, /archived: 2026-08-31/)
    assert.match(text, /owner: me/)
    assert.match(text, /See \[\[other-topic\]\]\./)
    await assert.rejects(readFile(join(root, 'active', 'active-topic.md'), 'utf8'))
  }
})

test('archiving preserves the project association', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  await writeFile(
    join(root, 'active', 'active-topic.md'),
    active.replace('owner: me', 'project: "D:\\\\Development\\\\Toucan"')
  )
  const library = createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' })
  const archived = await library.archive('active-topic', 'resolved')
  assert.equal(archived.ok && archived.topic.projectPath, 'D:\\Development\\Toucan')
})

test('lifecycle changes preserve complex unknown YAML fields verbatim', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  const markdown = active.replace('owner: me', 'tags:\n  - storage\nnotes: |\n  keep: this text\n# comment')
  await writeFile(join(root, 'active', 'active-topic.md'), markdown)
  const result = await createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' }).archive(
    'active-topic',
    'resolved'
  )
  assert.equal(result.ok, true)
  const archived = await readFile(join(root, 'archived', 'active-topic.md'), 'utf8')
  assert.match(archived, /tags:\n {2}- storage\nnotes: \|\n {2}keep: this text\n# comment/)
})

test('resolution reports active, archived, missing, invalid, and duplicate conflicts', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  await mkdir(join(root, 'archived'), { recursive: true })
  await writeFile(join(root, 'active', 'active-topic.md'), active)
  const archived = active.replace('---\n\n#', 'outcome: resolved\narchived: 2026-08-31\n---\n\n#')
  await writeFile(join(root, 'archived', 'archived-topic.md'), archived)
  await writeFile(join(root, 'archived', 'active-topic.md'), archived)
  const library = createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' })
  assert.equal((await library.resolve('archived-topic')).status, 'found')
  assert.deepEqual(await library.resolve('missing-topic'), { status: 'missing', slug: 'missing-topic' })
  assert.equal((await library.resolve('../escape')).status, 'invalid')
  assert.equal((await library.resolve('active-topic')).status, 'conflict')
})

test('mutations reject malicious slugs, missing sources, and destinations without changing sources', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  await mkdir(join(root, 'archived'), { recursive: true })
  await writeFile(join(root, 'active', 'active-topic.md'), active)
  await writeFile(join(root, 'archived', 'active-topic.md'), active)
  const library = createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' })
  for (const slug of ['', '.', '..', '../x', 'x.md', '%2e%2e', 'C-drive']) {
    const result = await library.archive(slug, 'resolved')
    assert.equal(result.ok, false, slug)
    if (!result.ok) assert.equal(result.code, 'invalid-slug')
  }
  const missing = await library.archive('not-here', 'resolved')
  assert.equal(missing.ok, false)
  const conflict = await library.archive('active-topic', 'resolved')
  assert.equal(conflict.ok, false)
  assert.equal(await readFile(join(root, 'active', 'active-topic.md'), 'utf8'), active)
  assert.deepEqual(
    (await readdir(join(root, 'archived'))).filter((name) => name.includes('.tmp')),
    []
  )
})

test('lifecycle mutations are serialized so concurrent archives cannot both succeed', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  await writeFile(join(root, 'active', 'active-topic.md'), active)
  const library = createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' })
  const results = await Promise.all([
    library.archive('active-topic', 'implemented'),
    library.archive('active-topic', 'resolved')
  ])
  assert.equal(results.filter((result) => result.ok).length, 1)
  assert.equal(results.filter((result) => !result.ok).length, 1)
})

test('assigning a project rewrites only the project field and leaves the rest of the topic intact', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  await writeFile(join(root, 'active', 'active-topic.md'), active)
  const library = createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' })

  const assigned = await library.assignProject('active-topic', 'D:\\Development\\Toucan')
  assert.equal(assigned.ok, true)
  if (assigned.ok) assert.equal(assigned.topic.projectPath, 'D:\\Development\\Toucan')
  const text = await readFile(join(root, 'active', 'active-topic.md'), 'utf8')
  assert.match(text, /^project: "D:\\\\Development\\\\Toucan"$/m)
  assert.match(text, /^owner: me$/m)
  assert.match(text, /See \[\[other-topic\]\]\./)
  // A metadata correction is not new material, so the topic keeps the date it was last written.
  assert.match(text, /^updated: 2026-08-30$/m)

  const reassigned = await library.assignProject('active-topic', 'D:\\Development\\Other')
  assert.equal(reassigned.ok, true)
  const rewritten = await readFile(join(root, 'active', 'active-topic.md'), 'utf8')
  assert.equal(rewritten.match(/^project:/gm)?.length, 1)
  assert.match(rewritten, /^project: "D:\\\\Development\\\\Other"$/m)

  const cleared = await library.assignProject('active-topic', undefined)
  assert.equal(cleared.ok, true)
  if (cleared.ok) assert.equal(cleared.topic.projectPath, undefined)
  const unassigned = await readFile(join(root, 'active', 'active-topic.md'), 'utf8')
  assert.equal(unassigned.match(/^project:/gm), null)
  assert.match(unassigned, /^owner: me$/m)
})

test('assignment rejects bad slugs, bad paths, missing topics, and archived snapshots', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  await mkdir(join(root, 'archived'), { recursive: true })
  await writeFile(join(root, 'active', 'active-topic.md'), active)
  const archived = active.replace('---\\n\\n#', 'outcome: resolved\\narchived: 2026-08-31\\n---\\n\\n#')
  await writeFile(join(root, 'archived', 'archived-topic.md'), archived)
  const library = createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' })

  const badSlug = await library.assignProject('../escape', 'D:\\Development\\Toucan')
  assert.equal(badSlug.ok, false)
  if (!badSlug.ok) assert.equal(badSlug.code, 'invalid-slug')

  for (const path of ['', 'projects/Toucan', './relative']) {
    const result = await library.assignProject('active-topic', path)
    assert.equal(result.ok, false, path)
    if (!result.ok) assert.equal(result.code, 'invalid-project')
  }

  const missing = await library.assignProject('not-here', 'D:\\Development\\Toucan')
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.code, 'missing-source')

  const immutable = await library.assignProject('archived-topic', 'D:\\Development\\Toucan')
  assert.equal(immutable.ok, false)
  if (!immutable.ok) assert.equal(immutable.code, 'immutable-archive')
  assert.equal(await readFile(join(root, 'archived', 'archived-topic.md'), 'utf8'), archived)
  assert.equal(await readFile(join(root, 'active', 'active-topic.md'), 'utf8'), active)
  assert.deepEqual(
    (await readdir(join(root, 'active'))).filter((name) => name.includes('.tmp')),
    []
  )
})

test('assignment refuses a malformed topic rather than rewriting it', async () => {
  const root = await libraryRoot()
  await mkdir(join(root, 'active'), { recursive: true })
  const malformed = '# no frontmatter\\n'
  await writeFile(join(root, 'active', 'active-topic.md'), malformed)
  const library = createBrainDumpLibrary({ rootDirectory: root, today: () => '2026-08-31' })
  const result = await library.assignProject('active-topic', 'D:\\Development\\Toucan')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'malformed-source')
  assert.equal(await readFile(join(root, 'active', 'active-topic.md'), 'utf8'), malformed)
})
