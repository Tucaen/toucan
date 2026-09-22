import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
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

test('a missing file under a root reached through a link is not-found, not a refusal', async () => {
  await withRoot(async (root) => {
    const real = join(root, 'real')
    await mkdir(join(real, 'docs'), { recursive: true })
    const link = join(root, 'link')
    await symlink(real, link, 'junction')
    const view = createFileView({ roots: async () => [link] })

    // The root exists, so it canonicalizes to `real`; the missing file cannot be canonicalized at
    // all. Comparing one against the other is what used to read as climbing out of the workspace,
    // which turned "this file is gone" into a refusal on every junctioned or short-path project.
    const missing = await view.read(join(link, 'docs', 'gone.md'))
    assert.equal(!missing.ok && missing.reason, 'not-found')

    const save = await view.write({ path: join(link, 'docs', 'gone.md'), content: 'x', baseMtime: 'whatever' })
    assert.equal(!save.ok && save.reason, 'not-found')
  })
})

test('a write to a name that does not exist yet cannot escape through a link either', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project')
    const elsewhere = join(root, 'elsewhere')
    await mkdir(project, { recursive: true })
    await mkdir(elsewhere, { recursive: true })
    await symlink(elsewhere, join(project, 'linked'), 'junction')
    const view = createFileView({ roots: async () => [project] })

    // The link is inside the project and the final segment is new, so nothing on this path fails
    // to resolve except the file name itself - which is exactly the case that must still be
    // judged by where the link actually lands, not by how the path reads.
    const escaping = await view.write({
      path: join(project, 'linked', 'planted.txt'),
      content: 'x',
      baseMtime: 'whatever'
    })
    assert.equal(!escaping.ok && escaping.reason, 'outside-workspace')
    assert.deepEqual(await readdir(elsewhere), [])
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

/*
 * Writing (issue #148): the same in-project guard as reading, an atomic replace through a
 * temporary file, and a refusal - never a silent overwrite - when the file on disk is no longer
 * the one the edit was based on.
 */

test('writes a file inside a registered project atomically and reports the new base', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project')
    await mkdir(join(project, 'docs'), { recursive: true })
    const file = join(project, 'docs', 'notes.md')
    await writeFile(file, '# Notes\n', 'utf8')
    const view = createFileView({ roots: async () => [project] })
    const before = await view.read(file)
    assert.ok(before.ok)

    const written = await view.write({ path: file, content: '# Notes\n\nEdited.\n', baseMtime: before.mtime })
    assert.ok(written.ok)
    assert.equal(written.size, Buffer.byteLength('# Notes\n\nEdited.\n'))
    assert.equal(written.content, '# Notes\n\nEdited.\n')
    const after = await view.read(file)
    assert.ok(after.ok)
    assert.equal(after.content, '# Notes\n\nEdited.\n')
    assert.equal(after.mtime, written.mtime)
    // No temporary file is left beside the document.
    assert.deepEqual(await readdir(join(project, 'docs')), ['notes.md'])
  })
})

test('formats a supported file before its atomic replacement and reports the written content', async () => {
  await withRoot(async (root) => {
    const file = join(root, 'styles.css')
    await writeFile(file, 'a {}\n', 'utf8')
    const view = createFileView({
      roots: async () => [root],
      formatter: async (_path, content) => ({ content: content.replace('red', 'blue') })
    })
    const base = await view.read(file)
    assert.ok(base.ok)

    const written = await view.write({ path: file, content: 'a { color: red; }', baseMtime: base.mtime })
    assert.ok(written.ok)
    assert.equal(written.content, 'a { color: blue; }')
    assert.equal(await readFile(file, 'utf8'), 'a { color: blue; }')
  })
})

test('a formatter failure does not prevent saving the submitted content', async () => {
  await withRoot(async (root) => {
    const file = join(root, 'styles.css')
    await writeFile(file, 'a {}\n', 'utf8')
    const view = createFileView({
      roots: async () => [root],
      formatter: async () => {
        throw new Error('formatter unavailable')
      }
    })
    const base = await view.read(file)
    assert.ok(base.ok)

    const written = await view.write({ path: file, content: 'a {', baseMtime: base.mtime })
    assert.ok(written.ok)
    assert.equal(written.content, 'a {')
    assert.equal(written.formatWarning, 'formatter unavailable')
    assert.equal(await readFile(file, 'utf8'), 'a {')
  })
})

test('an external change during formatting is still a conflict and is not overwritten', async () => {
  await withRoot(async (root) => {
    const file = join(root, 'styles.css')
    await writeFile(file, 'a {}\n', 'utf8')
    let finishFormatting: (content: string) => void = () => {}
    const view = createFileView({
      roots: async () => [root],
      formatter: (_path, content) =>
        new Promise((resolve) => {
          finishFormatting = (formatted) => resolve({ content: formatted || content })
        })
    })
    const base = await view.read(file)
    assert.ok(base.ok)

    const saving = view.write({ path: file, content: 'mine', baseMtime: base.mtime })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(file, 'theirs', 'utf8')
    finishFormatting('formatted mine')

    const result = await saving
    assert.equal(!result.ok && result.reason, 'conflict')
    assert.equal(await readFile(file, 'utf8'), 'theirs')
  })
})

test('refuses to write outside every registered root, with no file created', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(root, 'secret.txt'), 'nope', 'utf8')
    const view = createFileView({ roots: async () => [project] })

    const outside = await view.write({ path: join(root, 'secret.txt'), content: 'x', baseMtime: 'whatever' })
    assert.equal(!outside.ok && outside.reason, 'outside-workspace')
    assert.equal(await readFile(join(root, 'secret.txt'), 'utf8'), 'nope')

    const climbing = await view.write({ path: join(project, '..', 'new.txt'), content: 'x', baseMtime: 'whatever' })
    assert.equal(!climbing.ok && climbing.reason, 'outside-workspace')
    assert.deepEqual((await readdir(root)).sort(), ['project', 'secret.txt'])
  })
})

test('a file changed on disk since the edit began is a conflict, and nothing is overwritten', async () => {
  await withRoot(async (root) => {
    const file = join(root, 'plan.md')
    await writeFile(file, 'v1', 'utf8')
    const view = createFileView({ roots: async () => [root] })
    const base = await view.read(file)
    assert.ok(base.ok)

    // Another writer lands in between; make sure the clock moved so the mtime differs.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(file, 'v2 from elsewhere', 'utf8')
    const external = await view.read(file)
    assert.ok(external.ok && external.mtime !== base.mtime)

    const conflict = await view.write({ path: file, content: 'v2 from the node', baseMtime: base.mtime })
    assert.equal(!conflict.ok && conflict.reason, 'conflict')
    assert.equal(await readFile(file, 'utf8'), 'v2 from elsewhere')

    // Re-based on the current disk state, the same write goes through.
    const rebased = await view.write({ path: file, content: 'v2 from the node', baseMtime: external.mtime })
    assert.ok(rebased.ok)
    assert.equal(await readFile(file, 'utf8'), 'v2 from the node')
  })
})

test('a file that vanished or turned into a folder is not recreated by a save', async () => {
  await withRoot(async (root) => {
    const view = createFileView({ roots: async () => [root] })
    const gone = await view.write({ path: join(root, 'gone.md'), content: 'x', baseMtime: '2026-09-05T00:00:00.000Z' })
    assert.equal(!gone.ok && gone.reason, 'not-found')
    assert.deepEqual(await readdir(root), [])

    await mkdir(join(root, 'docs'))
    const folder = await view.write({ path: join(root, 'docs'), content: 'x', baseMtime: '2026-09-05T00:00:00.000Z' })
    assert.equal(!folder.ok && folder.reason, 'directory')
  })
})

test('a CRLF file survives a round trip through the editor, formatted or not', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    const notes = join(project, 'notes.txt')
    await writeFile(notes, 'one\r\ntwo\r\nthree\r\n', 'utf8')
    // Prettier itself defaults to LF, so a formatted file is the case that would silently convert.
    const view = createFileView({
      roots: async () => [project],
      formatter: async (_path, content, lineEnding) => ({
        content: content.replace(/\r?\n/g, lineEnding === 'crlf' ? '\r\n' : '\n')
      })
    })

    const read = await view.read(notes)
    assert.ok(read.ok)
    assert.equal(read.lineEnding, 'crlf')

    // What the editor hands back: the same text with every line ending flattened to LF.
    const written = await view.write({
      path: notes,
      content: 'one\nTWO\nthree\n',
      baseMtime: read.mtime,
      lineEnding: read.lineEnding
    })
    assert.ok(written.ok)
    assert.equal(await readFile(notes, 'utf8'), 'one\r\nTWO\r\nthree\r\n')
    // The editor adopts what was saved in the form it reads in, so an untouched file is not dirty.
    assert.equal(written.content, 'one\nTWO\nthree\n')
  })
})

test('an LF file is left with LF endings even when the submitted draft carries carriage returns', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    const notes = join(project, 'notes.txt')
    await writeFile(notes, 'one\ntwo\n', 'utf8')
    const view = createFileView({ roots: async () => [project] })

    const read = await view.read(notes)
    assert.ok(read.ok)
    assert.equal(read.lineEnding, 'lf')

    const written = await view.write({
      path: notes,
      content: 'one\r\ntwo\r\nthree\r\n',
      baseMtime: read.mtime,
      lineEnding: read.lineEnding
    })
    assert.ok(written.ok)
    assert.equal(await readFile(notes, 'utf8'), 'one\ntwo\nthree\n')
  })
})
