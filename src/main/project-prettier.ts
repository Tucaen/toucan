import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { LineEnding } from '../shared/line-endings'
import { withStallGuard } from '../shared/stall-guard'
import { hiddenWindowsPreloadOption } from './agent-process'
import { hiddenProcessOptions } from './background-process'
import { directoriesUpTo } from './workspace-containment'

export interface ProjectPrettierRequest {
  path: string
  content: string
  /** The checkout the file belongs to; the search for an install stops there. */
  root: string
  /** Forced on Prettier, so the project's configuration cannot convert the file's line endings. */
  lineEnding: LineEnding
}

/**
 * `reason` is a clause a caller can put in a sentence of its own: "<config>, and ${reason}, so ...".
 */
export type ProjectPrettierResult = { ok: true; content: string } | { ok: false; reason: string }

export type ProjectPrettier = (request: ProjectPrettierRequest) => Promise<ProjectPrettierResult>

export interface ProjectPrettierOptions {
  /** A save must finish. A configuration that does not is abandoned, not waited on. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The program the child runs, with no access to anything in this module. It is a string because it
 * is handed to `-e`: there is no second entry point to build, package and keep in step, and an
 * argument vector cannot be mis-quoted by a shell that is never started. Whether the file is
 * supported and whether it is ignored are already settled by the caller, and so is *which* install
 * to use, so all this does is what only that install can: resolve the configuration - executable
 * forms included - and format with it.
 */
const CHILD_PROGRAM = [
  'const [, installed, file, lineEnding] = process.argv',
  "let text = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', (chunk) => { text += chunk })",
  "process.stdin.on('end', async () => {",
  '  try {',
  "    const prettier = require(require.resolve('prettier', { paths: [installed] }))",
  '    const config = (await prettier.resolveConfig(file, { editorconfig: true })) || {}',
  '    process.stdout.write(await prettier.format(text, { ...config, filepath: file, endOfLine: lineEnding }))',
  '  } catch (error) {',
  '    process.stderr.write(String((error && error.message) || error))',
  '    process.exitCode = 1',
  '  }',
  '})'
].join('\n')

/**
 * Formats a file-node save with the *project's own* Prettier, in a child process.
 *
 * `prettier.config.js` and its relatives are not settings, they are code: the settings are what
 * running them returns. `prettier-project-config.ts` therefore cannot read them, and a project
 * that uses one would get every save left unformatted. Running them is the only way to honour
 * them - so this runs them where a checkout's code is allowed to run, which is anywhere but
 * Toucan's privileged main process. No shell is involved, the child is launched through the same
 * hidden-window policy as an ACP adapter and passes it on to anything the configuration spawns
 * itself, and a configuration that hangs or throws becomes a reason rather than a save that never
 * completes.
 *
 * It is deliberately the project's install and never Toucan's bundled copy: a JavaScript
 * configuration usually exists to load a plugin, and only the project's own `node_modules` has
 * that plugin. Which install that is, is decided *here*, bounded by the checkout, and handed to
 * the child - the child never searches for one itself, so there is one rule rather than two.
 * A checkout with no Prettier installed has nothing to run, and says so.
 *
 * The environment is main's own, because Prettier and its plugins need the `PATH` and the Node
 * settings any other tool in that checkout would get; what is *not* passed is anything about the
 * file beyond its path and its text.
 */
export function createProjectPrettier(options: ProjectPrettierOptions = {}): ProjectPrettier {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return async ({ path, content, root, lineEnding }) => {
    const installed = await installDirectory(path, root)
    if (!installed) return { ok: false, reason: 'this checkout has no Prettier installed to run it with' }
    const child = spawn(
      process.execPath,
      ['-e', CHILD_PROGRAM, installed, path, lineEnding],
      hiddenProcessOptions({
        cwd: installed,
        env: {
          ...process.env,
          // `ELECTRON_RUN_AS_NODE` is what makes Toucan's own binary usable as the Node the
          // project's Prettier runs on, so this needs nothing installed beside the app.
          ELECTRON_RUN_AS_NODE: '1',
          NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), hiddenWindowsPreloadOption].filter(Boolean).join(' ')
        },
        stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe']
      })
    )
    const ran = new Promise<ProjectPrettierResult>((settle) => {
      let formatted = ''
      let failure = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => (formatted += chunk))
      child.stderr.on('data', (chunk: string) => (failure += chunk))
      child.on('error', (error) => settle({ ok: false, reason: `running it could not be started (${error.message})` }))
      child.on('close', (code) =>
        settle(
          code === 0
            ? { ok: true, content: formatted }
            : { ok: false, reason: `running it failed (${said(failure, code)})` }
        )
      )
      // The child can exit before it has read everything; that is a failure to report from its
      // exit, not an unhandled error on a pipe nobody is left to read.
      child.stdin.on('error', () => {})
      child.stdin.end(content, 'utf8')
    })
    try {
      return await withStallGuard(ran, timeoutMs, `running it did not finish within ${timeoutMs}ms`)
    } catch (error) {
      // `ran` only ever settles, so the deadline is the one thing that can reject here.
      return { ok: false, reason: (error as Error).message }
    } finally {
      child.kill()
    }
  }
}

function said(failure: string, code: number | null): string {
  const first = failure.trim().split('\n')[0]
  if (first) return first
  return code === null ? 'it was stopped' : `exit ${code}`
}

/** The nearest directory between the file and its checkout that has Prettier installed. */
async function installDirectory(path: string, root: string): Promise<string | undefined> {
  for (const directory of directoriesUpTo(path, root)) {
    try {
      await access(join(directory, 'node_modules', 'prettier', 'package.json'))
      return directory
    } catch {
      continue
    }
  }
  return undefined
}
