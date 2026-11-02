import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { runGitWithExecFile } from '../src/main/git-worktree'
import { createLocalFileOpener } from '../src/main/local-file-open'
import { createRemoteFileReader } from '../src/main/remote/remote-file-reader'
import { ensureScratchDirectory } from '../src/main/scratch-directory'
import { createWorkspaceContainment } from '../src/main/workspace-containment'
import { classifyMarkdownLink, fileUrlOf } from '../src/shared/local-file-link'
import { SCRATCH_DIRECTORY_NAME, SCRATCH_EXCLUDE_PATTERN } from '../src/shared/scratch-directory'

// The scratch folder (#3): where a session saves what the human is meant to open. Driven against
// real repositories, because what matters is what git says about the folder (ignored, so `merge`
// and `cleanup` never see untracked work) and that the unchanged workspace gate admits it.

const identity = {
  GIT_AUTHOR_NAME: 'Toucan Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Toucan Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid'
}

// Real `git` spawns, which the full suite runs on a saturated machine; see ticket-push-guard.test.ts.
const GIT_FIXTURE_TIMEOUT = 120_000

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* left for the OS temp cleanup */
    }
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8', stdio: 'pipe' })
}

function repository(): { root: string; project: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'toucan-scratch-'))
  roots.push(root)
  const project = join(root, 'My Project')
  git(root, 'init', '--initial-branch=main', project)
  writeFileSync(join(project, 'README.md'), 'hello\n')
  git(project, 'add', 'README.md')
  git(project, 'commit', '-m', 'initial')
  const worktree = join(root, 'My Project-ticket-3')
  git(project, 'worktree', 'add', '-b', 'ticket/3', worktree, 'main')
  return { root, project, worktree }
}

/** The exact check `merge` and `cleanup` make of a checkout: any output is untracked or changed work. */
const dirty = (cwd: string): string => git(cwd, 'status', '--porcelain', '--untracked-files=all').trim()

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

test(
  'the folder is ignored in the main checkout and every worktree, so neither sees work to merge',
  async () => {
    const { project, worktree } = repository()
    const result = await ensureScratchDirectory(project, runGitWithExecFile)
    assert.deepEqual(result, { ok: true, path: join(project, SCRATCH_DIRECTORY_NAME) })

    writeFileSync(join(project, SCRATCH_DIRECTORY_NAME, 'before.png'), PNG)
    mkdirSync(join(project, SCRATCH_DIRECTORY_NAME, 'ticket-3'))
    writeFileSync(join(project, SCRATCH_DIRECTORY_NAME, 'ticket-3', 'report.md'), '# report\n')

    // The target checkout stays clean for `merge`, and a ticket worktree for `cleanup`.
    assert.equal(dirty(project), '')
    assert.equal(dirty(worktree), '')
    // The project's own `.gitignore` was never touched: Toucan does not need a commit in a user's repo.
    assert.equal(existsSync(join(project, '.gitignore')), false)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a file in the scratch folder survives its ticket worktree being removed',
  async () => {
    const { project, worktree } = repository()
    const result = await ensureScratchDirectory(project, runGitWithExecFile)
    assert.ok(result.ok)
    const saved = join(result.path, 'after.png')
    writeFileSync(saved, PNG)

    // Not forced: nothing in the scratch folder is the worktree's untracked work.
    git(project, 'worktree', 'remove', worktree)
    assert.equal(existsSync(worktree), false)
    assert.deepEqual(readFileSync(saved), PNG)
    assert.equal(dirty(project), '')
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'preparing it twice writes one ignore line and keeps what the file already said',
  async () => {
    const { project } = repository()
    const exclude = join(project, '.git', 'info', 'exclude')
    // No trailing newline: the appended line must not fuse onto the user's last one.
    writeFileSync(exclude, '*.log')

    assert.ok((await ensureScratchDirectory(project, runGitWithExecFile)).ok)
    assert.ok((await ensureScratchDirectory(project, runGitWithExecFile)).ok)

    const lines = readFileSync(exclude, 'utf8').split('\n')
    assert.equal(lines[0], '*.log')
    assert.equal(lines.filter((line) => line === SCRATCH_EXCLUDE_PATTERN).length, 1)
  },
  GIT_FIXTURE_TIMEOUT
)

test('a folder that is not a git repository gets no scratch folder, and nothing is created', async () => {
  const root = mkdtempSync(join(tmpdir(), 'toucan-scratch-plain-'))
  roots.push(root)
  const result = await ensureScratchDirectory(root, runGitWithExecFile)
  assert.equal(result.ok, false)
  assert.equal(existsSync(join(root, SCRATCH_DIRECTORY_NAME)), false)
})

test(
  'the unchanged workspace gate admits a scratch file on the desktop and in the phone reader, and still refuses temp',
  async () => {
    const { root, project } = repository()
    const result = await ensureScratchDirectory(project, runGitWithExecFile)
    assert.ok(result.ok)
    const scratchFile = join(result.path, 'before shot.png')
    writeFileSync(scratchFile, PNG)
    // A sibling of the project, standing in for the system temp folder an agent's screenshot lands in.
    const elsewhere = join(root, 'temp-shot.png')
    writeFileSync(elsewhere, PNG)

    const containment = createWorkspaceContainment({ roots: () => [project] })
    assert.equal(await containment.contains(scratchFile), true)
    assert.equal(await containment.contains(elsewhere), false)

    // Desktop: the very link a session is told to write classifies to the file, which the opener hands to the OS.
    const link = classifyMarkdownLink(fileUrlOf(scratchFile))
    assert.deepEqual(link, { kind: 'file', path: scratchFile })
    const opened: string[] = []
    const open = createLocalFileOpener({
      contains: containment.contains,
      openPath: async (path) => {
        opened.push(path)
        return ''
      }
    })
    assert.deepEqual(await open(scratchFile), { ok: true })
    assert.deepEqual(opened, [scratchFile])
    const refused = await open(elsewhere)
    assert.equal(refused.ok === false && refused.reason, 'outside-workspace')

    // Phone: the same gate in `GET /api/file`.
    const read = createRemoteFileReader({ contains: containment.contains })
    const served = await read(scratchFile)
    assert.ok(served.ok)
    assert.equal(served.contentType, 'image/png')
    assert.deepEqual(served.data, PNG)
    const phoneRefused = await read(elsewhere)
    assert.equal(phoneRefused.ok === false && phoneRefused.status, 403)
  },
  GIT_FIXTURE_TIMEOUT
)
