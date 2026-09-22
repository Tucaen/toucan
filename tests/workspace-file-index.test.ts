import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createWorkspaceFileIndex } from '../src/main/workspace-file-index'

const listing = (paths: string[]) => async () => ({ ok: true, paths })
const noGit = async (): Promise<{ ok: false }> => ({ ok: false })

test('a git checkout is listed through git, so .gitignore is honoured for free', async () => {
  const index = createWorkspaceFileIndex({ listTracked: listing(['README.md', 'src/main/index.ts']) })

  const result = await index.read('/repo')

  assert.equal(result.gitignored, true)
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ['README.md', 'src', 'src/main', 'src/main/index.ts']
  )
})

test('every directory on the way to a file is offerable, and each appears once', async () => {
  const index = createWorkspaceFileIndex({
    listTracked: listing(['src/main/index.ts', 'src/main/terminal-manager.ts', 'src/shared/agent.ts'])
  })

  const result = await index.read('/repo')

  assert.deepEqual(
    result.entries.filter((entry) => entry.directory).map((entry) => entry.path),
    ['src', 'src/main', 'src/shared']
  )
})

test('git paths keep forward slashes whatever the platform reported', async () => {
  const index = createWorkspaceFileIndex({ listTracked: listing(['src\\main\\index.ts']) })

  const result = await index.read('D:\\repo')

  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ['src', 'src/main', 'src/main/index.ts']
  )
})

test('a directory git cannot read falls back to a walk, and says .gitignore is not in force', async () => {
  const index = createWorkspaceFileIndex({
    listTracked: noGit,
    walk: async () => ({ paths: ['notes.md'], truncated: false })
  })

  const result = await index.read('/scratch')

  assert.equal(result.gitignored, false)
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ['notes.md']
  )
})

test('the index is bounded, and says so rather than pretending to be complete', async () => {
  const many = Array.from({ length: 12 }, (_value, position) => `file-${position}.ts`)
  const index = createWorkspaceFileIndex({ listTracked: listing(many), limit: 5 })

  const result = await index.read('/repo')

  assert.equal(result.truncated, true)
  assert.equal(result.entries.length, 5)
})

test('a repeated read inside the cache window never walks the repository again', async () => {
  let reads = 0
  const index = createWorkspaceFileIndex({
    listTracked: async () => {
      reads += 1
      return { ok: true, paths: ['README.md'] }
    },
    now: () => 1_000,
    ttlMs: 10_000
  })

  await index.read('/repo')
  await index.read('/repo')

  assert.equal(reads, 1)
})

test('the cache expires, so a file created since the last read becomes mentionable', async () => {
  let clock = 0
  let reads = 0
  const index = createWorkspaceFileIndex({
    listTracked: async () => {
      reads += 1
      return { ok: true, paths: reads === 1 ? ['README.md'] : ['README.md', 'new.ts'] }
    },
    now: () => clock,
    ttlMs: 1_000
  })

  await index.read('/repo')
  clock = 5_000
  const result = await index.read('/repo')

  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ['README.md', 'new.ts']
  )
})

test('concurrent reads of the same directory share one walk', async () => {
  let reads = 0
  const index = createWorkspaceFileIndex({
    listTracked: async () => {
      reads += 1
      return { ok: true, paths: ['README.md'] }
    }
  })

  await Promise.all([index.read('/repo'), index.read('/repo'), index.read('/repo')])

  assert.equal(reads, 1)
})

test('each working directory is indexed separately, so a worktree never shows the checkout', async () => {
  const index = createWorkspaceFileIndex({
    listTracked: async (root) => ({ ok: true, paths: [`${root === '/worktree' ? 'branch' : 'main'}.ts`] })
  })

  assert.equal((await index.read('/worktree')).entries[0].path, 'branch.ts')
  assert.equal((await index.read('/checkout')).entries[0].path, 'main.ts')
})

test('a directory with no path reports nothing rather than indexing the process cwd', async () => {
  const index = createWorkspaceFileIndex({
    listTracked: async () => {
      throw new Error('should never be asked')
    }
  })

  assert.deepEqual((await index.read('')).entries, [])
})

test('a listing that throws costs the completion, never the composer', async () => {
  const index = createWorkspaceFileIndex({
    listTracked: async () => {
      throw new Error('git exploded')
    },
    walk: async () => {
      throw new Error('walk exploded')
    }
  })

  const result = await index.read('/repo')

  assert.deepEqual(result.entries, [])
  assert.equal(result.gitignored, false)
})

test('the default walk skips heavy build directories and reports real files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'toucan-file-index-'))
  try {
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules', 'react'), { recursive: true })
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'src', 'index.ts'), '')
    writeFileSync(join(root, 'node_modules', 'react', 'index.js'), '')
    writeFileSync(join(root, '.git', 'HEAD'), '')

    const index = createWorkspaceFileIndex({ listTracked: noGit })
    const result = await index.read(root)

    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      ['src', 'src/index.ts']
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
