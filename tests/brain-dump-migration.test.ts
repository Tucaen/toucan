import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrateBrainDumps } from '../src/main/brain-dump-migration'

const topic = (title: string, body = ''): string =>
  `---\ntitle: ${title}\ncreated: 2026-08-30\nupdated: 2026-08-31\n---\n\n# ${title}\n\n${body}\n`

test('migration plans and imports legacy topics while converting only known topic links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toucan-migration-'))
  const source = join(directory, 'legacy')
  const destination = join(directory, 'brain-dumps')
  await mkdir(source)
  await writeFile(
    join(source, 'first-topic.md'),
    topic('First', '[Second](second-topic.md) [Web](https://example.com/x.md)')
  )
  await writeFile(join(source, 'second-topic.md'), topic('Second'))
  const result = await migrateBrainDumps({ sourceDirectory: source, rootDirectory: destination })
  assert.equal(result.ok, true)
  assert.deepEqual(result.imported, ['first-topic', 'second-topic'])
  assert.match(await readFile(join(destination, 'active', 'first-topic.md'), 'utf8'), /\[\[second-topic\]\]/)
  assert.match(await readFile(join(destination, 'active', 'first-topic.md'), 'utf8'), /https:\/\/example\.com\/x\.md/)
  assert.equal(result.plan.length, 2)
  const repeated = await migrateBrainDumps({ sourceDirectory: source, rootDirectory: destination })
  assert.equal(repeated.ok, false)
  assert.deepEqual(repeated.skipped, ['first-topic', 'second-topic'])
})

test('migration performs no writes when any source is malformed or any slug collides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toucan-migration-'))
  const source = join(directory, 'legacy')
  const destination = join(directory, 'brain-dumps')
  await mkdir(source)
  await mkdir(join(destination, 'archived'), { recursive: true })
  await writeFile(join(source, 'good-topic.md'), topic('Good'))
  await writeFile(join(source, 'bad-topic.md'), '# broken')
  await writeFile(join(destination, 'archived', 'good-topic.md'), topic('Good', 'outcome missing'))
  let planned = false
  const result = await migrateBrainDumps({
    sourceDirectory: source,
    rootDirectory: destination,
    onPlan: () => {
      planned = true
    }
  })
  assert.equal(result.ok, false)
  assert.equal(planned, true)
  assert.ok(result.failed.length > 0)
  await assert.rejects(readdir(join(destination, 'active')))
})
