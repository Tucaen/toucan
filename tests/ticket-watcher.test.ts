import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTicketChangeWatcher } from '../src/main/ticket-watcher'

type WatchListener = (eventType: string, filename: string | Buffer | null) => void

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'toucan-ticket-watcher-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 25))

test('a watched project coalesces Markdown changes into one event per project', async () => {
  await withRoot(async (root) => {
    const callbacks = new Map<string, WatchListener>()
    const closed: string[] = []
    const sent: Array<[string, string]> = []
    const owner = { isDestroyed: () => false, send: (channel: string, path: string) => sent.push([channel, path]) }
    const alpha = join(root, 'alpha')
    const beta = join(root, 'beta')

    const watcher = createTicketChangeWatcher({
      directoryFor: (projectPath) => join(projectPath, 'docs', 'tickets'),
      debounceMs: 5,
      watchDirectory: (path, callback) => {
        callbacks.set(path, callback)
        return { close: () => closed.push(path) }
      }
    })
    watcher.subscribe(owner)
    await watcher.watchProject(alpha)
    await watcher.watchProject(beta)
    // A second list of the same project must not open a second watcher on the same folder.
    await watcher.watchProject(alpha)
    assert.equal(callbacks.size, 2)

    const alphaFolder = callbacks.get(join(alpha, 'docs', 'tickets'))!
    alphaFolder('rename', '.ticket-board.tmp')
    alphaFolder('rename', 'ticket-board.md')
    alphaFolder('change', 'ticket-board.md')
    callbacks.get(join(beta, 'docs', 'tickets'))!('rename', 'other.md')

    await settle()
    assert.deepEqual(sent, [
      ['tickets:changed', alpha],
      ['tickets:changed', beta]
    ])

    watcher.shutdown()
    assert.deepEqual(closed.sort(), [join(alpha, 'docs', 'tickets'), join(beta, 'docs', 'tickets')].sort())
  })
})

test('a change with no filename still refreshes, and a non-Markdown one does not', async () => {
  await withRoot(async (root) => {
    let callback: WatchListener | undefined
    const sent: string[] = []
    const watcher = createTicketChangeWatcher({
      directoryFor: (projectPath) => projectPath,
      debounceMs: 5,
      watchDirectory: (_path, listener) => {
        callback = listener
        return { close: () => undefined }
      }
    })
    watcher.subscribe({ isDestroyed: () => false, send: (_channel, path) => sent.push(path) })
    await watcher.watchProject(root)

    callback!('change', 'notes.txt')
    await settle()
    assert.deepEqual(sent, [])

    callback!('rename', null)
    await settle()
    assert.deepEqual(sent, [root])
    watcher.shutdown()
  })
})

test('a destroyed window stops receiving events and is forgotten', async () => {
  await withRoot(async (root) => {
    let callback: WatchListener | undefined
    const sent: string[] = []
    let destroyed = false
    const watcher = createTicketChangeWatcher({
      directoryFor: (projectPath) => projectPath,
      debounceMs: 5,
      watchDirectory: (_path, listener) => {
        callback = listener
        return { close: () => undefined }
      }
    })
    watcher.subscribe({ isDestroyed: () => destroyed, send: (_channel, path) => sent.push(path) })
    await watcher.watchProject(root)

    destroyed = true
    callback!('change', 'ticket.md')
    await settle()
    assert.deepEqual(sent, [])
    watcher.shutdown()
  })
})

test('a project with no tickets folder is not watched, and no folder is created for it', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'no-tickets')
    const folder = join(project, 'docs', 'tickets')
    const attempts: string[] = []
    const watcher = createTicketChangeWatcher({
      directoryFor: () => folder,
      debounceMs: 5,
      watchDirectory: (path) => {
        attempts.push(path)
        // What `fs.watch` does when the folder is not there.
        const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
    })
    await watcher.watchProject(project)
    assert.equal(existsSync(folder), false)

    // Unclaimed, so the next listing tries again once the folder exists.
    await watcher.watchProject(project)
    assert.deepEqual(attempts, [folder, folder])
    watcher.shutdown()
  })
})

test('the last window leaving releases the OS watch handles', async () => {
  await withRoot(async (root) => {
    const closed: string[] = []
    const watcher = createTicketChangeWatcher({
      directoryFor: (projectPath) => projectPath,
      debounceMs: 5,
      watchDirectory: (path) => ({ close: () => closed.push(path) })
    })
    const first = { isDestroyed: () => false, send: () => {} }
    const second = { isDestroyed: () => false, send: () => {} }
    watcher.subscribe(first)
    watcher.subscribe(second)
    await watcher.watchProject(root)

    watcher.disconnectOwner(first)
    assert.deepEqual(closed, [])

    watcher.disconnectOwner(second)
    assert.deepEqual(closed, [root])

    // A new window re-watches from its first listing rather than inheriting a closed handle.
    watcher.subscribe(first)
    await watcher.watchProject(root)
    watcher.shutdown()
    assert.deepEqual(closed, [root, root])
  })
})

test('a project whose tickets folder setting changed is watched on the new folder', async () => {
  await withRoot(async (root) => {
    const callbacks = new Map<string, WatchListener>()
    const closed: string[] = []
    const sent: string[] = []
    let folder = join(root, 'docs', 'tickets')
    const watcher = createTicketChangeWatcher({
      directoryFor: () => folder,
      debounceMs: 5,
      watchDirectory: (path, listener) => {
        callbacks.set(path, listener)
        return { close: () => closed.push(path) }
      }
    })
    watcher.subscribe({ isDestroyed: () => false, send: (_channel, path) => sent.push(path) })
    await watcher.watchProject(root)

    const moved = join(root, 'notes', 'tickets')
    folder = moved
    await watcher.watchProject(root)
    // The handle on the folder the project has left is released, not leaked for the session.
    assert.deepEqual(closed, [join(root, 'docs', 'tickets')])

    callbacks.get(moved)!('change', 'ticket.md')
    await settle()
    assert.deepEqual(sent, [root])
    watcher.shutdown()
  })
})

test('a folder setting that changed to one that does not exist drops the old watcher', async () => {
  await withRoot(async (root) => {
    const closed: string[] = []
    let folder = join(root, 'docs', 'tickets')
    const watcher = createTicketChangeWatcher({
      directoryFor: () => folder,
      debounceMs: 5,
      watchDirectory: (path) => {
        if (path !== join(root, 'docs', 'tickets')) throw new Error('ENOENT: no such file or directory')
        return { close: () => closed.push(path) }
      }
    })
    watcher.subscribe({ isDestroyed: () => false, send: () => {} })
    await watcher.watchProject(root)

    folder = join(root, 'notes', 'tickets')
    await watcher.watchProject(root)
    assert.deepEqual(closed, [join(root, 'docs', 'tickets')])
    watcher.shutdown()
  })
})

test('a settled change reaches main as well as the board, once per coalesced burst', async () => {
  await withRoot(async (root) => {
    const callbacks = new Map<string, WatchListener>()
    const changed: string[] = []
    const watcher = createTicketChangeWatcher({
      directoryFor: (projectPath) => join(projectPath, 'docs', 'tickets'),
      debounceMs: 5,
      onChanged: (projectPath) => changed.push(projectPath),
      watchDirectory: (path, callback) => {
        callbacks.set(path, callback)
        return { close: () => {} }
      }
    })
    // Deliberately no subscriber: main's own enforcement must not depend on a window listening.
    await watcher.watchProject(root)

    const folder = callbacks.get(join(root, 'docs', 'tickets'))!
    folder('rename', 'to-tickets.md')
    folder('change', 'to-tickets.md')
    await settle()
    assert.deepEqual(changed, [root])

    folder('change', 'to-tickets.md')
    await settle()
    assert.deepEqual(changed, [root, root])
    watcher.shutdown()
  })
})
