import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createLocalFileOpener } from '../src/main/local-file-open'

/*
 * Covers issue #175: the privileged half of opening a local artifact link. Handing a file to its
 * associated application is the one path action that can *run* something, so it fails closed the
 * same way a file-node read does - inside the workspace, an inert media type, and actually on
 * disk - and every refusal says why rather than doing nothing.
 */

const roots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'toucan-open-'))
  roots.push(root)
  return root
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

function opener(root: string): {
  open: (path: string) => Promise<import('../src/shared/local-file-link').LocalFileOpenResult>
  handed: string[]
  failure: { message: string }
} {
  const handed: string[] = []
  const failure = { message: '' }
  const containment = { contains: async (path: string) => path.toLowerCase().startsWith(root.toLowerCase()) }
  return {
    open: createLocalFileOpener({
      contains: containment.contains,
      openPath: async (path) => {
        handed.push(path)
        return failure.message
      }
    }),
    handed,
    failure
  }
}

test('an image inside the workspace is handed to the OS viewer', async () => {
  const root = await workspace()
  await mkdir(join(root, 'docs'), { recursive: true })
  const target = join(root, 'docs', 'My Game studies.png')
  await writeFile(target, 'not really a png')
  const { open, handed } = opener(root)

  assert.deepEqual(await open(target.replace(/\\/g, '/')), { ok: true })
  // Whatever separators the link used, the OS is handed the resolved native path.
  assert.deepEqual(handed, [target])
})

test('a path outside every project and worktree is refused before anything is opened', async () => {
  const root = await workspace()
  const { open, handed } = opener(root)

  const result = await open(join(tmpdir(), 'elsewhere', 'shot.png'))
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'outside-workspace')
  assert.match(result.ok === false ? result.message : '', /outside every project/i)
  assert.deepEqual(handed, [])
})

test('a file kind the OS would execute is never handed over', async () => {
  const root = await workspace()
  const target = join(root, 'install.bat')
  await writeFile(target, 'echo hi')
  const { open, handed } = opener(root)

  const result = await open(target)
  assert.equal(result.ok === false && result.reason, 'unsupported-type')
  assert.deepEqual(handed, [])
})

test('a missing target and a folder each report what is wrong', async () => {
  const root = await workspace()
  await mkdir(join(root, 'art.png'), { recursive: true })
  const { open, handed } = opener(root)

  const missing = await open(join(root, 'gone.png'))
  assert.equal(missing.ok === false && missing.reason, 'not-found')
  assert.match(missing.ok === false ? missing.message : '', /not on disk/i)

  const folder = await open(join(root, 'art.png'))
  assert.equal(folder.ok === false && folder.reason, 'directory')
  assert.deepEqual(handed, [])
})

test("the OS refusing to open the file is reported in the OS's own words", async () => {
  const root = await workspace()
  const target = join(root, 'studies.png')
  await writeFile(target, 'bytes')
  const { open, failure } = opener(root)
  failure.message = 'No application is associated with this file'

  const result = await open(target)
  assert.equal(result.ok === false && result.reason, 'unopenable')
  assert.match(result.ok === false ? result.message : '', /No application is associated/)
})

test('a blank path is refused rather than resolved to the current directory', async () => {
  const root = await workspace()
  const { open, handed } = opener(root)

  assert.equal((await open('   ')).ok, false)
  assert.deepEqual(handed, [])
})
