import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { readZipEntries } from '../src/main/zip-extract'

/**
 * The minimal ZIP reader behind the engine download. The archives here are built by hand from the
 * same records the format defines, so the reader is proven against the wire shape rather than
 * against another library's writer; the one real archive it ever reads is SHA-256-pinned, which is
 * what makes this small surface enough.
 */

interface Entry {
  name: string
  data: Buffer
  method: 0 | 8
}

function buildZip(entries: Entry[], comment = ''): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const stored = entry.method === 8 ? deflateRawSync(entry.data) : entry.data
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, stored)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(entry.method, 10)
    record.writeUInt32LE(stored.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += 30 + name.length + stored.length
  }
  const directory = Buffer.concat(central)
  const commentBytes = Buffer.from(comment, 'utf8')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(commentBytes.length, 20)
  return Buffer.concat([...parts, directory, end, commentBytes])
}

describe('readZipEntries', () => {
  test('reads stored and deflated entries by base name, flattening the archive folder', () => {
    const zip = buildZip([
      { name: 'Release/server.exe', data: Buffer.from('machine code'), method: 8 },
      { name: 'Release/notes.txt', data: Buffer.from('plain'), method: 0 },
      { name: 'Release/extra.dll', data: Buffer.from('unwanted'), method: 8 }
    ])
    const entries = readZipEntries(zip, ['server.exe', 'notes.txt'])
    assert.deepEqual(
      entries.map((entry) => [entry.name, Buffer.from(entry.bytes).toString()]),
      [
        ['server.exe', 'machine code'],
        ['notes.txt', 'plain']
      ]
    )
  })

  test('finds the end record behind a zip comment', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x'), method: 0 }], 'built by hand')
    assert.equal(Buffer.from(readZipEntries(zip, ['a.txt'])[0].bytes).toString(), 'x')
  })

  test('a missing requested entry is an error, never a silent half-extraction', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x'), method: 0 }])
    assert.throws(() => readZipEntries(zip, ['a.txt', 'gone.dll']), /missing: gone\.dll/)
  })

  test('refuses non-archives and compressions it does not speak', () => {
    assert.throws(() => readZipEntries(Buffer.from('not a zip at all, but long enough to scan'), ['a']), /Not a zip/)
    const zip = buildZip([{ name: 'a.bin', data: Buffer.from('x'), method: 0 }])
    // Rewrite the central directory's method to an unsupported one (12 = bzip2).
    const methodOffset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10
    zip.writeUInt16LE(12, methodOffset)
    assert.throws(() => readZipEntries(zip, ['a.bin']), /unsupported compression/)
  })
})
