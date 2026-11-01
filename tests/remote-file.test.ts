import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, test } from 'vitest'
import { createRemoteFileReader } from '../src/main/remote/remote-file-reader'
import {
  REMOTE_SHELL_SECURITY_HEADERS,
  resolveRemoteRoute,
  routeRequiresPairing
} from '../src/main/remote/remote-routes'
import { createWorkspaceContainment } from '../src/main/workspace-containment'
import {
  isRemoteFetchablePath,
  remoteFileRequestPath,
  remoteImageContentType,
  remoteImagePath
} from '../src/shared/remote-file'

/**
 * A phone opening an image an agent linked to: which links qualify, how the request is routed, and
 * the reader's gates - the first place a paired device can read the desktop's disk.
 */

const roots: string[] = []

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'toucan-remote-file-'))
  roots.push(root)
  return root
}

describe('which links the phone may fetch', () => {
  test('absolute local images in every form the desktop recognizes', () => {
    assert.equal(remoteImagePath('D:\\proj\\shot.png'), 'D:\\proj\\shot.png')
    assert.equal(remoteImagePath('D:/proj/shot.PNG'), 'D:\\proj\\shot.PNG')
    assert.equal(remoteImagePath('/D:/proj/a%20b.jpg'), 'D:\\proj\\a b.jpg')
    assert.equal(remoteImagePath('D:%5Cproj%5Cshot.webp'), 'D:\\proj\\shot.webp')
    assert.equal(remoteImagePath('file:///D:/proj/shot.gif'), 'D:\\proj\\shot.gif')
    assert.equal(remoteImagePath('/home/me/shot.avif'), '/home/me/shot.avif')
  })

  test('nothing else: relative, web, UNC, SVG and non-image links', () => {
    for (const href of [
      'docs/shot.png',
      './shot.png',
      'https://example.com/shot.png',
      '\\\\server\\share\\shot.png',
      'file://server/share/shot.png',
      'D:\\proj\\logo.svg',
      'D:\\proj\\notes.md',
      'D:\\proj\\run.bat',
      'javascript:alert(1)',
      undefined
    ]) {
      assert.equal(remoteImagePath(href), null, String(href))
    }
  })

  test('a UNC or device path is never fetchable, so the host is never made to dial out', () => {
    assert.equal(isRemoteFetchablePath('\\\\server\\share\\x.png'), false)
    assert.equal(isRemoteFetchablePath('\\\\?\\D:\\x.png'), false)
    assert.equal(isRemoteFetchablePath('//server/share/x.png'), false)
    assert.equal(isRemoteFetchablePath('/tmp/x.png\0'), false)
    assert.equal(isRemoteFetchablePath('x.png'), false)
    assert.equal(isRemoteFetchablePath('D:\\x.png'), true)
  })

  test('only inert raster kinds have a content type', () => {
    assert.equal(remoteImageContentType('a.JPEG'), 'image/jpeg')
    assert.equal(remoteImageContentType('a.svg'), null)
    assert.equal(remoteImageContentType('a.pdf'), null)
    assert.equal(remoteImageContentType('png'), null)
  })
})

describe('routing a file request', () => {
  test('the path travels encoded in the query and the route needs the token', () => {
    const route = resolveRemoteRoute('GET', remoteFileRequestPath('D:\\a b\\#1?.png'))
    assert.deepEqual(route, { kind: 'file', path: 'D:\\a b\\#1?.png' })
    assert.equal(routeRequiresPairing(route), true)
  })

  test('a missing path is still the file route, refused by the reader; writes are not allowed', () => {
    assert.deepEqual(resolveRemoteRoute('GET', '/api/file'), { kind: 'file', path: '' })
    assert.deepEqual(resolveRemoteRoute('POST', '/api/file'), { kind: 'method-not-allowed', allow: 'GET, HEAD' })
  })

  test('the page may show blob: images and still no other origin', () => {
    const policy = REMOTE_SHELL_SECURITY_HEADERS['content-security-policy']
    assert.match(policy, /img-src 'self' data: blob:;/)
    assert.match(policy, /script-src 'self';/)
  })
})

describe('reading a linked image', () => {
  async function setup(byteLimit?: number): Promise<{
    root: string
    outside: string
    read: ReturnType<typeof createRemoteFileReader>
  }> {
    const base = await workspace()
    const root = join(base, 'project')
    const outside = join(base, 'elsewhere')
    await mkdir(join(root, 'shots'), { recursive: true })
    await mkdir(outside, { recursive: true })
    const containment = createWorkspaceContainment({ roots: () => [root] })
    return {
      root,
      outside,
      read: createRemoteFileReader({ contains: containment.contains, ...(byteLimit ? { byteLimit } : {}) })
    }
  }

  test('an image inside the workspace is served with its content type', async () => {
    const { root, read } = await setup()
    const target = join(root, 'shots', 'one.png')
    await writeFile(target, 'png bytes')
    const result = await read(target)
    assert.ok(result.ok)
    assert.equal(result.contentType, 'image/png')
    assert.equal(result.data.toString(), 'png bytes')
  })

  test('outside the workspace, or escaping it with "..", is refused without being read', async () => {
    const { root, outside, read } = await setup()
    await writeFile(join(outside, 'secret.png'), 'secret')
    for (const path of [join(outside, 'secret.png'), `${root}${'/..'}/elsewhere/secret.png`]) {
      const result = await read(path)
      assert.ok(!result.ok)
      assert.equal(result.status, 403)
      assert.ok(!result.message.includes('secret'), 'a refusal never echoes the path')
    }
  })

  test('a non-image, a relative path and a missing path are refused before the disk is asked', async () => {
    const { root, read } = await setup()
    await writeFile(join(root, 'notes.md'), 'text')
    for (const path of [join(root, 'notes.md'), join(root, 'logo.svg'), 'shots/one.png', '']) {
      const result = await read(path)
      assert.ok(!result.ok)
      assert.equal(result.status, 400, path)
    }
  })

  test('a missing file and a folder named like an image are not found', async () => {
    const { root, read } = await setup()
    await mkdir(join(root, 'folder.png'))
    for (const path of [join(root, 'gone.png'), join(root, 'folder.png')]) {
      const result = await read(path)
      assert.ok(!result.ok)
      assert.equal(result.status, 404, path)
    }
  })

  test('an image over the size bound is refused', async () => {
    const { root, read } = await setup(4)
    await writeFile(join(root, 'big.png'), '12345')
    const result = await read(join(root, 'big.png'))
    assert.ok(!result.ok)
    assert.equal(result.status, 413)
  })
})
