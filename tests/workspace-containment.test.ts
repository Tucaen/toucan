import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll as after, test } from 'vitest'
import { createWorkspaceContainment, directoriesUpTo, isWithin } from '../src/main/workspace-containment'

/*
 * The privilege gate every path operation the renderer can ask for passes through: a file node's
 * read and write, and handing an artifact to the OS viewer. `tests/file-view.test.ts` covers what
 * a refusal means to a file node; this covers the rule itself, including the case each caller
 * reports differently - the root of a project, which is inside the workspace but is not a file.
 */

const made: string[] = []

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'toucan-contain-'))
  made.push(path)
  return path
}

after(async () => {
  for (const path of made) await rm(path, { recursive: true, force: true })
})

test('a path under a registered root is contained; a sibling of it is not', async () => {
  const root = await directory()
  const outside = await directory()
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'plan.md'), '#')
  const containment = createWorkspaceContainment({ roots: () => [root] })

  assert.equal(await containment.contains(join(root, 'docs', 'plan.md')), true)
  // A name that does not exist yet still answers, so a save can be checked before it writes.
  assert.equal(await containment.contains(join(root, 'docs', 'not-written-yet.md')), true)
  assert.equal(await containment.contains(join(outside, 'plan.md')), false)
  // A prefix match is not containment: `<root>-other` is a different directory.
  assert.equal(await containment.contains(`${root}-other/plan.md`), false)
})

test('the root itself is inside the workspace, so callers can refuse it as a folder', async () => {
  const root = await directory()
  const containment = createWorkspaceContainment({ roots: () => [root] })

  assert.equal(await containment.contains(root), true)
  assert.equal(await containment.contains(join(root, '..')), false)
})

test('a link inside a root that points out of it is refused, whatever the path says', async () => {
  const root = await directory()
  const outside = await directory()
  await writeFile(join(outside, 'secret.txt'), 'no')
  try {
    await symlink(outside, join(root, 'escape'), 'junction')
  } catch {
    return // Creating links needs a privilege this machine may not grant.
  }
  const containment = createWorkspaceContainment({ roots: () => [root] })

  assert.equal(await containment.contains(join(root, 'escape', 'secret.txt')), false)
})

test('roots are read per call, so a project added a moment ago is already usable', async () => {
  const first = await directory()
  const second = await directory()
  const roots = [first]
  const containment = createWorkspaceContainment({ roots: () => roots })

  assert.equal(await containment.contains(join(second, 'a.png')), false)
  roots.push(second)
  assert.equal(await containment.contains(join(second, 'a.png')), true)
})

test('the case rule decides how two spellings of one path are compared', async () => {
  const root = await directory()
  const insensitive = createWorkspaceContainment({ roots: () => [root], caseInsensitivePaths: true })
  const sensitive = createWorkspaceContainment({ roots: () => [root], caseInsensitivePaths: false })

  assert.equal(insensitive.comparable('D:\\Projects\\My Game'), 'd:\\projects\\my game')
  assert.equal(sensitive.comparable('D:\\Projects\\My Game'), 'D:\\Projects\\My Game')
  // Either way a real path under the root is contained: `realpath` already canonicalizes the
  // spelling of every part that exists, which is most of why the flag rarely shows.
  assert.equal(await insensitive.contains(join(root.toUpperCase(), 'a.png')), true)
})

test('a directory whose name merely begins with dots is inside the root', async () => {
  const root = await directory()
  await mkdir(join(root, '..config'), { recursive: true })
  await writeFile(join(root, '..config', 'settings.json'), '{}')
  const containment = createWorkspaceContainment({ roots: () => [root] })

  assert.equal(await containment.contains(join(root, '..config', 'settings.json')), true)
  assert.equal(isWithin(root, join(root, '..config', 'settings.json')), true)
  // The one step out that the leading dots must not be mistaken for.
  assert.equal(isWithin(root, join(root, '..')), false)
  assert.equal(isWithin(root, join(root, '..', 'sibling.txt')), false)
  assert.equal(isWithin(root, root), true)
})

test('the walk up to a boundary stops at it, and never starts outside it', () => {
  const root = resolve('/', 'work', 'project')
  assert.deepEqual(
    [...directoriesUpTo(join(root, 'src', 'deep', 'a.ts'), root)],
    [join(root, 'src', 'deep'), join(root, 'src'), root]
  )
  assert.deepEqual([...directoriesUpTo(join(root, 'a.ts'), root)], [root])
  // A file that was never under the boundary has nothing to ask, rather than climbing to the root.
  assert.deepEqual([...directoriesUpTo(resolve('/', 'work', 'other', 'a.ts'), root)], [])
})
