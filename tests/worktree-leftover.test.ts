import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { describeRemovalFailure, removeTree } from '../src/main/worktree-leftover'

function deepFolder() {
  const root = mkdtempSync(join(tmpdir(), 'toucan-leftover-'))
  const deep = join(root, ...Array.from({ length: 14 }, (_, index) => `godot-check-project-${index}`))
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(deep, 'icon.png.import'), 'generated')
  return { root, file: join(deep, 'icon.png.import') }
}

test('a removal failure names the longest remaining path, its length and the remedy', async () => {
  const { root, file } = deepFolder()
  try {
    const message = await describeRemovalFailure(root, 'Filename too long')
    assert.ok(message.startsWith('Filename too long'))
    assert.ok(message.includes(`${file.length} characters (${file})`))
    assert.match(message, /LongPathsEnabled/)
    assert.match(message, /core\.longpaths/)
    assert.match(message, /shorter worktree root/)
  } finally {
    await removeTree(root)
  }
})

test('a removal failure unrelated to path length keeps its own message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'toucan-leftover-'))
  writeFileSync(join(root, 'a.txt'), 'a')
  try {
    assert.equal(await describeRemovalFailure(root, 'EBUSY: resource busy'), 'EBUSY: resource busy')
  } finally {
    await removeTree(root)
  }
})

test('removeTree deletes paths beyond MAX_PATH and refuses relative paths and roots', async () => {
  const { root } = deepFolder()
  await removeTree(root)
  assert.equal(existsSync(root), false)
  await assert.rejects(removeTree('relative/path'), /relative/)
  await assert.rejects(removeTree(process.platform === 'win32' ? 'C:\\' : '/'), /root/)
})

// A folder another account wrote - a sandboxed agent's temp output - denies its contents to the
// user. Node's own `maxRetries` loops on that EPERM forever, which froze the remove dialog.
test.skipIf(process.platform !== 'win32')(
  'removeTree fails promptly on a folder the user may not open',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'toucan-leftover-'))
    const locked = join(root, 'pytest-of-someone')
    mkdirSync(locked)
    writeFileSync(join(locked, 'a.txt'), 'a')
    execFileSync('icacls', [locked, '/inheritance:r', '/deny', `${process.env.USERNAME}:(OI)(CI)F`])
    try {
      const started = Date.now()
      await assert.rejects(removeTree(root))
      assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started} ms`)
    } finally {
      execFileSync('icacls', [locked, '/reset'])
      await removeTree(root)
    }
  },
  15_000
)
