import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SCRATCH_DIRECTORY_NAME, SCRATCH_EXCLUDE_PATTERN } from '../shared/scratch-directory'
import { errorMessage } from '../shared/text'
import type { GitRunner } from './git-worktree'

export type ScratchDirectoryResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * Prepares the project's scratch folder (#3; see `shared/scratch-directory.ts`) and says where it is.
 *
 * Toucan works on projects it does not own, so the folder is ignored through the repository's
 * `info/exclude` - local to the clone, never committed - rather than by editing the project's
 * `.gitignore`. That file is the one a worktree and the main checkout share, wherever the project
 * was cloned, so one line covers the main checkout and every ticket worktree. The ignore matters
 * beyond tidiness: `merge` and `cleanup` refuse a checkout with untracked files, and an unignored
 * scratch folder would block the next merge of the orchestration it was made for.
 *
 * The ignore is checked with git rather than assumed, as the push guard does: a folder git still
 * reports as untracked is not one to send sessions to. Idempotent, and a failure is a result, never
 * a throw - a project that is not a git repository simply gets no scratch folder.
 */
export async function ensureScratchDirectory(projectPath: string, runGit: GitRunner): Promise<ScratchDirectoryResult> {
  const failed = (step: string, detail: string): ScratchDirectoryResult => ({
    ok: false,
    error: `could not prepare the scratch folder (${step}): ${detail.trim() || 'git failed'}`
  })
  try {
    const exclude = await runGit(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], projectPath)
    if (exclude.code !== 0) return failed('locating the repository ignore file', exclude.stderr)
    const excludePath = exclude.stdout.trim()

    const existing = await readFile(excludePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    if (!existing.split(/\r?\n/).some((line) => line.trim() === SCRATCH_EXCLUDE_PATTERN)) {
      await mkdir(dirname(excludePath), { recursive: true })
      const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
      await appendFile(
        excludePath,
        `${separator}# Toucan: files its sessions save for you to open\n${SCRATCH_EXCLUDE_PATTERN}\n`
      )
    }

    const path = join(projectPath, SCRATCH_DIRECTORY_NAME)
    await mkdir(path, { recursive: true })

    const ignored = await runGit(['check-ignore', '-q', `${SCRATCH_DIRECTORY_NAME}/probe`], projectPath)
    if (ignored.code !== 0)
      return failed('verifying the ignore rule', ignored.stderr || 'git does not ignore the folder')
    return { ok: true, path }
  } catch (error) {
    return failed('writing the ignore rule', errorMessage(error))
  }
}
