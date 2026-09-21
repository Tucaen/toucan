import { createHash, type Hash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeSnapshotAtomically } from './durable-file'
import type { VoiceModelPort } from './voice-model-store'
import { readZipEntries } from './zip-extract'

/**
 * The real IO behind `voice-model-store.ts`: streaming downloads verified against the pinned size
 * and SHA-256, and the engine-archive extraction. Kept apart from the policy so the store is
 * tested without a network. The hash check is not hygiene: one of these files is an executable,
 * and the pin in `shared/whisper-assets.ts` is what makes "downloaded" mean "reviewed".
 *
 * A killed download resumes: the partial `.download` file is hashed and the request continues with
 * a `Range` header, because losing 90% of a 1.6 GB checkpoint to a dropped connection is the
 * first-run experience this store exists to avoid. A server that ignores the range simply restarts
 * the file. Extracted binaries and the marker go through `durable-file`'s snapshot write, so a
 * crash never leaves an executable that exists at its final name with half its bytes.
 */
export function createVoiceModelPort(): VoiceModelPort {
  return {
    fileSize(path): number | null {
      try {
        const stats = statSync(path)
        return stats.isFile() ? stats.size : null
      } catch {
        return null
      }
    },
    readText(path): string | null {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    async writeText(path, text): Promise<void> {
      await mkdir(dirname(path), { recursive: true })
      await writeSnapshotAtomically(path, text)
    },
    async download(file, destination, onProgress): Promise<void> {
      // A file already at its pinned size was verified when it was renamed into place.
      if (statSize(destination) === file.size) return
      await mkdir(dirname(destination), { recursive: true })
      const temporary = `${destination}.download`
      // Resume what an earlier attempt left, folding its bytes into the running hash first.
      let alreadyReceived = statSize(temporary) ?? 0
      if (alreadyReceived >= file.size) {
        await rm(temporary, { force: true })
        alreadyReceived = 0
      }
      let hash = createHash('sha256')
      if (alreadyReceived > 0) await hashFile(temporary, hash)
      const response = await fetch(file.url, {
        headers: alreadyReceived > 0 ? { range: `bytes=${alreadyReceived}-` } : {}
      })
      if (!response.ok || !response.body) {
        throw new Error(`Failed to download ${file.name}: ${response.status} ${response.statusText}`)
      }
      // Only a 206 honoured the range; a 200 is the whole file again, so the partial is discarded.
      if (alreadyReceived > 0 && response.status !== 206) {
        alreadyReceived = 0
        hash = createHash('sha256')
        await rm(temporary, { force: true })
      }
      const handle = await open(temporary, alreadyReceived > 0 ? 'a' : 'w')
      let received = alreadyReceived
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          await handle.write(chunk)
          hash.update(chunk)
          received += chunk.byteLength
          onProgress(received)
        }
        // Flushed before the rename: the rename is what promotes the file to "verified", and a
        // torn executable that exists at its final name is exactly what the choreography forbids.
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (received !== file.size) {
        // Undersized is a resumable partial and stays for the next attempt; anything else is wrong.
        if (received > file.size) await rm(temporary, { force: true })
        throw new Error(`Size mismatch for ${file.name}: expected ${file.size} bytes, received ${received}.`)
      }
      const digest = hash.digest('hex')
      if (digest !== file.sha256) {
        await rm(temporary, { force: true })
        throw new Error(`Checksum mismatch for ${file.name}: expected ${file.sha256}, received ${digest}.`)
      }
      await rename(temporary, destination)
    },
    async extractZip(zipPath, entries, directory): Promise<void> {
      const extracted = readZipEntries(await readFile(zipPath), entries)
      await mkdir(directory, { recursive: true })
      for (const entry of extracted) {
        await writeSnapshotAtomically(join(directory, entry.name), entry.bytes)
      }
    },
    remove: (path) => rm(path, { force: true })
  }
}

function statSize(path: string): number | null {
  try {
    const stats = statSync(path)
    return stats.isFile() ? stats.size : null
  } catch {
    return null
  }
}

function hashFile(path: string, hash: Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
}
