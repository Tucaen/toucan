import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { centerSquareCrop, PROJECT_AVATAR_PIXEL_SIZE, projectAvatarFileName } from '../src/shared/project-avatar'
import {
  createProjectAvatarStore,
  type DecodedAvatarSource,
  type ProjectAvatarStoreDependencies
} from '../src/main/project-avatar-store'

describe('centerSquareCrop', () => {
  test('landscape crops the horizontal excess evenly', () => {
    assert.deepEqual(centerSquareCrop(200, 100), { x: 50, y: 0, width: 100, height: 100 })
  })

  test('portrait crops the vertical excess evenly', () => {
    assert.deepEqual(centerSquareCrop(100, 300), { x: 0, y: 100, width: 100, height: 100 })
  })

  test('a square image is untouched', () => {
    assert.deepEqual(centerSquareCrop(128, 128), { x: 0, y: 0, width: 128, height: 128 })
  })

  test('an odd remainder leans toward the top-left, keeping integer pixels', () => {
    assert.deepEqual(centerSquareCrop(101, 100), { x: 0, y: 0, width: 100, height: 100 })
    assert.deepEqual(centerSquareCrop(100, 103), { x: 0, y: 1, width: 100, height: 100 })
  })

  test('degenerate sizes still produce a usable rect', () => {
    assert.deepEqual(centerSquareCrop(0, 0), { x: 0, y: 0, width: 1, height: 1 })
  })
})

describe('projectAvatarFileName', () => {
  test('a UUID id names its own png', () => {
    assert.equal(projectAvatarFileName('a1b2c3d4-e5f6'), 'a1b2c3d4-e5f6.png')
  })

  test('path separators and traversal are dropped, never honoured', () => {
    assert.equal(projectAvatarFileName('..\\..\\evil'), 'evil.png')
    assert.equal(projectAvatarFileName('../up/../../etc'), 'upetc.png')
  })

  test('an id that sanitizes to nothing names no file', () => {
    assert.equal(projectAvatarFileName('../..'), null)
    assert.equal(projectAvatarFileName(''), null)
  })
})

describe('project avatar store', () => {
  const pngBytes = Buffer.from('not-a-real-png-but-bytes')

  function fixture(overrides: Partial<ProjectAvatarStoreDependencies> = {}): {
    deps: ProjectAvatarStoreDependencies
    directory: string
    crops: Array<{ rect: { x: number; y: number; width: number; height: number }; edge: number }>
  } {
    const directory = join(mkdtempSync(join(tmpdir(), 'avatar-store-')), 'avatars')
    const crops: Array<{ rect: { x: number; y: number; width: number; height: number }; edge: number }> = []
    const source: DecodedAvatarSource = {
      width: 640,
      height: 480,
      toPng: (rect, edge) => {
        crops.push({ rect, edge })
        return pngBytes
      }
    }
    const deps: ProjectAvatarStoreDependencies = {
      directory,
      pickImageFile: async () => 'C:/pictures/logo.jpg',
      decodeImage: async () => source,
      ...overrides
    }
    return { deps, directory, crops }
  }

  test('choose picks, normalizes, writes and reports a version', async () => {
    const { deps, directory, crops } = fixture()
    const store = createProjectAvatarStore(deps)
    const result = await store.choose(null, 'project-1')
    assert.equal(result.status, 'set')
    assert.ok(result.status === 'set' && result.version > 0)
    assert.deepEqual(crops, [{ rect: { x: 80, y: 0, width: 480, height: 480 }, edge: PROJECT_AVATAR_PIXEL_SIZE }])
    assert.deepEqual(await readFile(join(directory, 'project-1.png')), pngBytes)
    await rm(directory, { recursive: true, force: true })
  })

  test('read returns the stored avatar as a data URL, and null when there is none', async () => {
    const { deps, directory } = fixture()
    const store = createProjectAvatarStore(deps)
    assert.equal(await store.read('project-1'), null)
    await store.choose(null, 'project-1')
    assert.equal(await store.read('project-1'), `data:image/png;base64,${pngBytes.toString('base64')}`)
    await rm(directory, { recursive: true, force: true })
  })

  test('remove deletes the stored avatar and tolerates one that never existed', async () => {
    const { deps, directory } = fixture()
    const store = createProjectAvatarStore(deps)
    await store.choose(null, 'project-1')
    await store.remove('project-1')
    assert.equal(await store.read('project-1'), null)
    await store.remove('project-1')
    await rm(directory, { recursive: true, force: true })
  })

  test('a cancelled picker is a cancel, not a refusal', async () => {
    const { deps } = fixture({ pickImageFile: async () => null })
    const store = createProjectAvatarStore(deps)
    assert.deepEqual(await store.choose(null, 'project-1'), { status: 'cancelled' })
  })

  test('an undecodable file is refused with a message', async () => {
    const { deps } = fixture({ decodeImage: async () => null })
    const store = createProjectAvatarStore(deps)
    const result = await store.choose(null, 'project-1')
    assert.equal(result.status, 'refused')
    assert.ok(result.status === 'refused' && result.message.length > 0)
  })

  test('an id that names no file is refused before the picker opens', async () => {
    let picked = false
    const { deps } = fixture({
      pickImageFile: async () => {
        picked = true
        return null
      }
    })
    const store = createProjectAvatarStore(deps)
    const result = await store.choose(null, '../..')
    assert.equal(result.status, 'refused')
    assert.equal(picked, false)
    assert.equal(await store.read('../..'), null)
  })

  test('replacing an avatar reports a version the first set did not', async () => {
    const { deps, directory } = fixture()
    const store = createProjectAvatarStore(deps)
    const first = await store.choose(null, 'project-1')
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await store.choose(null, 'project-1')
    assert.ok(first.status === 'set' && second.status === 'set' && second.version > first.version)
    await rm(directory, { recursive: true, force: true })
  })
})
