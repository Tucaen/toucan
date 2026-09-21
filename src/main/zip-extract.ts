import { inflateRawSync } from 'node:zlib'

/**
 * Just enough of the ZIP format to unpack the pinned whisper.cpp release archive.
 *
 * Hand-rolled on purpose: the one archive this ever reads is named, sized and SHA-256-pinned in
 * `shared/whisper-assets.ts`, so the format surface is frozen by the pin - stored or deflated
 * entries, no zip64, no encryption - and a dependency would be carried for one verified file.
 * Entries are looked up by base name because the archive nests everything under a `Release/`
 * folder; the caller says which names it wants, and anything else in the archive is not read.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50

export interface ZipEntry {
  /** The entry's base name, its path inside the archive flattened away. */
  name: string
  bytes: Uint8Array
}

/**
 * The entries whose base names are in `names`, decompressed. Throws when the archive is not a zip,
 * uses a compression this reader does not speak, or lacks any requested name - a pinned archive
 * missing a pinned entry is a wrong pin, and half an engine must not extract silently.
 */
export function readZipEntries(archive: Buffer, names: readonly string[]): ZipEntry[] {
  const wanted = new Set(names)
  const found = new Map<string, Uint8Array>()
  const end = findEndOfCentralDirectory(archive)
  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) throw new Error('Damaged zip central directory.')
    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const headerOffset = archive.readUInt32LE(offset + 42)
    const fullName = archive.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    const baseName = fullName.slice(fullName.lastIndexOf('/') + 1)
    if (!wanted.has(baseName) || fullName.endsWith('/')) continue
    if (archive.readUInt32LE(headerOffset) !== LOCAL_HEADER) throw new Error(`Damaged zip entry for ${fullName}.`)
    const localNameLength = archive.readUInt16LE(headerOffset + 26)
    const localExtraLength = archive.readUInt16LE(headerOffset + 28)
    const dataStart = headerOffset + 30 + localNameLength + localExtraLength
    const compressed = archive.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) found.set(baseName, Uint8Array.from(compressed))
    else if (method === 8) found.set(baseName, Uint8Array.from(inflateRawSync(compressed)))
    else throw new Error(`Zip entry ${fullName} uses unsupported compression method ${method}.`)
  }
  const missing = names.filter((name) => !found.has(name))
  if (missing.length > 0) throw new Error(`The archive is missing: ${missing.join(', ')}.`)
  return names.map((name) => ({ name, bytes: found.get(name) as Uint8Array }))
}

function findEndOfCentralDirectory(archive: Buffer): number {
  // The record sits at the very end, behind a comment of up to 64 KiB; scan backwards for it.
  const floor = Math.max(0, archive.length - 65_557)
  for (let position = archive.length - 22; position >= floor; position -= 1) {
    if (archive.readUInt32LE(position) === END_OF_CENTRAL_DIRECTORY) return position
  }
  throw new Error('Not a zip archive: no end-of-central-directory record.')
}
