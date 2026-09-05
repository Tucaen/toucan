import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFileView } from '../src/main/file-view'

type WatchListener = (eventType: string, filename: string | Buffer | null) => void

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'toucan-file-view-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 25))

test('reads a file inside a registered project with its size and modification time', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project')
    await mkdir(join(project, 'docs'), { recursive: true })
    await writeFile(join(project, 'docs', 'notes.md'), '# Notes\n\nHello.\n', 'utf8')
    const view = createFileView({ roots: async () => [project] })

    const result = await view.read(join(project, 'docs', 'notes.md'))
    assert.ok(result.ok)
    assert.equal(result.content, '# Notes\n\nHello.\n')
    assert.equal(result.truncated, false)
    assert.equal(result.binary, false)
    assert.equal(result.size, Buffer.byteLength('# Notes\n\nHello.\n'))
    assert.ok(Number.isFinite(Date.parse(result.mtime)))
  })
})

test('refuses a path outside every registered root, including one that climbs out of a project', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(root, 'secret.txt'), 'nope', 'utf8')
    const view = createFileView({ roots: async () => [project] })

    const outside = await view.read(join(root, 'secret.txt'))
    assert.deepEqual(outside.ok, false)
    assert.equal(!outside.ok && outside.reason, 'outside-workspace')

    const climbing = await view.read(join(project, '..', 'secret.txt'))
    assert.equal(!climbing.ok && climbing.reason, 'outside-workspace')

    // A sibling directory that merely starts with the project's name is not inside it.
    await mkdir(`${project}-other`, { recursive: true })
    await writeFile(join(`${project}-other`, 'file.txt'), 'x', 'utf8')
    const sibling = await view.read(join(`${project}-other`, 'file.txt'))
    assert.equal(!sibling.ok && sibling.reason, 'outside-workspace')
  })
})

test('with no registered roots every read is refused rather than allowed by default', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'file.txt'), 'x', 'utf8')
    const view = createFileView({ roots: async () => [] })
    const result = await view.read(join(root, 'file.txt'))
    assert.equal(!result.ok && result.reason, 'outside-workspace')
  })
})

test('a worktree root is as readable as the project checkout, whatever the path case', async () => {
  await withRoot(async (root) => {
    const worktree = join(root, 'project-worktrees', 'feature')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, 'a.ts'), 'export {}\n', 'utf8')
    const view = createFileView({ roots: async () => [worktree.toUpperCase()], caseInsensitivePaths: true })
    const result = await view.read(join(worktree, 'a.ts'))
    assert.ok(result.ok)
  })
})

test('a missing file and a directory are named as such, never as a refusal', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'docs'), { recursive: true })
    const view = createFileView({ roots: async () => [root] })

    const missing = await view.read(join(root, 'docs', 'gone.md'))
    assert.equal(!missing.ok && missing.reason, 'not-found')

    const directory = await view.read(join(root, 'docs'))
    assert.equal(!directory.ok && directory.reason, 'directory')
  })
})

test('a file past the byte cap is cut there and reports its full size', async () => {
  await withRoot(async (root) => {
    const view = createFileView({ roots: async () => [root], maxBytes: 16 })
    await writeFile(join(root, 'big.txt'), 'abcdefghijklmnopqrstuvwxyz', 'utf8')
    const result = await view.read(join(root, 'big.txt'))
    assert.ok(result.ok)
    assert.equal(result.truncated, true)
    assert.equal(result.content, 'abcdefghijklmnop')
    assert.equal(result.size, 26)
  })
})

test('a file with NUL bytes is reported as binary with no content', async () => {
  await withRoot(async (root) => {
    const view = createFileView({ roots: async () => [root] })
    await writeFile(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]))
    const result = await view.read(join(root, 'image.bin'))
    assert.ok(result.ok)
    assert.equal(result.binary, true)
    assert.equal(result.content, '')
    assert.equal(result.size, 7)
  })
})

test('a watched file publishes one coalesced change to the windows watching it', async () => {
  await withRoot(async (root) => {
    const callbacks = new Map<string, WatchListener>()
    const closed: string[] = []
    const sent: Array<[string, string]> = []
    const owner = { isDestroyed: () => false, send: (channel: string, path: string) => sent.push([channel, path]) }
    await mkdir(join(root, 'docs'), { recursive: true })
    const file = join(root, 'docs', 'plan.md')
    await writeFile(file, '# Plan', 'utf8')

    const view = createFileView({
      roots: async () => [root],
      debounceMs: 5,
      watchDirectory: (path, listener) => {
        callbacks.set(path, listener)
        return { close: () => closed.push(path) }
      }
    })
    await view.watch(file, owner)
    // Watching twice from the same window is one watcher, not two.
    await view.watch(file, owner)
    assert.equal(callbacks.size, 1)

    const folder = callbacks.get(join(root, 'docs'))!
    folder('rename', '.plan.md.tmp')
    folder('change', 'other.md')
    await settle()
    assert.deepEqual(sent, [])

    folder('rename', 'plan.md')
    folder('change', 'plan.md')
    await settle()
    assert.deepEqual(sent, [['file-view:changed', file]])

    // A platform that cannot name the entry still refreshes: better a spare read than a stale view.
    folder('change', null)
    await settle()
    assert.equal(sent.length, 2)

    // Each watch is one hold, so the second node closing is what releases the handle.
    view.unwatch(file, owner)
    assert.deepEqual(closed, [])
    view.unwatch(file, owner)
    assert.deepEqual(closed, [join(root, 'docs')])
    folder('change', 'plan.md')
    await settle()
    assert.equal(sent.length, 2)
  })
})

test('watching refuses a path outside the workspace and a destroyed window is forgotten', async () => {
  await withRoot(async (root) => {
    const attempts: string[] = []
    let listener: WatchListener | undefined
    const sent: string[] = []
    let destroyed = false
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'a.md'), 'a', 'utf8')
    await writeFile(join(root, 'outside.md'), 'b', 'utf8')
    const view = createFileView({
      roots: async () => [project],
      debounceMs: 5,
      watchDirectory: (path, callback) => {
        attempts.push(path)
        listener = callback
        return { close: () => undefined }
      }
    })
    const owner = { isDestroyed: () => destroyed, send: (_channel: string, path: string) => sent.push(path) }

    await view.watch(join(root, 'outside.md'), owner)
    assert.deepEqual(attempts, [])

    await view.watch(join(project, 'a.md'), owner)
    assert.deepEqual(attempts, [project])
    destroyed = true
    listener!('change', 'a.md')
    await settle()
    assert.deepEqual(sent, [])
  })
})

test('a link inside the checkout that points outside it is refused, whatever the path says', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project')
    const elsewhere = join(root, 'elsewhere')
    await mkdir(project, { recursive: true })
    await mkdir(elsewhere, { recursive: true })
    await writeFile(join(elsewhere, 'secret.txt'), 'nope', 'utf8')
    // A junction needs no privilege on Windows and is a symlink everywhere else.
    await symlink(elsewhere, join(project, 'linked'), 'junction')
    const view = createFileView({ roots: async () => [project] })

    const result = await view.read(join(project, 'linked', 'secret.txt'))
    assert.equal(!result.ok && result.reason, 'outside-workspace')
  })
})

test('two nodes on the same file in one window keep the watch until the last one closes', async () => {
  await withRoot(async (root) => {
    const closed: string[] = []
    const sent: string[] = []
    let listener: WatchListener | undefined
    await writeFile(join(root, 'a.md'), 'a', 'utf8')
    const view = createFileView({
      roots: async () => [root],
      debounceMs: 5,
      watchDirectory: (path, callback) => {
        listener = callback
        return { close: () => closed.push(path) }
      }
    })
    const owner = { isDestroyed: () => false, send: (_channel: string, path: string) => sent.push(path) }
    await view.watch(join(root, 'a.md'), owner)
    await view.watch(join(root, 'a.md'), owner)

    view.unwatch(join(root, 'a.md'), owner)
    assert.deepEqual(closed, [])
    listener!('change', 'a.md')
    await settle()
    assert.equal(sent.length, 1)

    view.unwatch(join(root, 'a.md'), owner)
    assert.deepEqual(closed, [root])
    view.shutdown()
  })
})

test('an unwatch that arrives while the watch is still being set up wins', async () => {
  await withRoot(async (root) => {
    const attempts: string[] = []
    await writeFile(join(root, 'a.md'), 'a', 'utf8')
    const view = createFileView({
      // Slow enough that the unwatch below lands while the roots are still being read.
      roots: () => new Promise<string[]>((resolve) => setTimeout(() => resolve([root]), 20)),
      watchDirectory: (path) => {
        attempts.push(path)
        return { close: () => undefined }
      }
    })
    const owner = { isDestroyed: () => false, send: () => {} }
    // A node mounted and unmounted before main finished checking its roots - a fast close, or
    // React's development double-mount - must not leave a watcher nobody will ever release.
    const watching = view.watch(join(root, 'a.md'), owner)
    view.unwatch(join(root, 'a.md'), owner)
    await watching
    assert.deepEqual(attempts, [])
    view.shutdown()
  })
})

test('a window that disconnects releases the watch handles it alone was holding', async () => {
  await withRoot(async (root) => {
    const closed: string[] = []
    await writeFile(join(root, 'a.md'), 'a', 'utf8')
    await writeFile(join(root, 'b.md'), 'b', 'utf8')
    const view = createFileView({
      roots: async () => [root],
      debounceMs: 5,
      watchDirectory: (path) => ({ close: () => closed.push(path) })
    })
    const first = { isDestroyed: () => false, send: () => {} }
    const second = { isDestroyed: () => false, send: () => {} }
    await view.watch(join(root, 'a.md'), first)
    await view.watch(join(root, 'a.md'), second)
    await view.watch(join(root, 'b.md'), first)

    view.disconnectOwner(first)
    // `a.md` is still watched for the second window; only `b.md` lost its last watcher.
    assert.deepEqual(closed, [root])

    view.shutdown()
    assert.deepEqual(closed, [root, root])
  })
})
