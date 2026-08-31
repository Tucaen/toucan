import { constants } from 'node:fs'
import { access, open, rm } from 'node:fs/promises'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function writeNewFileDurably(path: string, contents: string): Promise<void> {
  try {
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
}

/** Flushes the promoted file and, where the platform supports it, its containing directory entry. */
export async function syncPromotedFile(path: string, directory: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  if (process.platform === 'win32') return
  const parent = await open(directory, 'r')
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}
