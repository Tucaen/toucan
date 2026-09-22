import { resolve } from 'node:path'
import { format, getFileInfo } from 'prettier'
import type { LineEnding } from '../shared/line-endings'
import { projectFormatting, savedUnformatted } from './prettier-project-config'
import type { ProjectPrettier } from './project-prettier'
import { isWithin } from './workspace-containment'

export interface FileFormatResult {
  content: string
  warning?: string
}

export type FileFormatter = (path: string, content: string, lineEnding?: LineEnding) => Promise<FileFormatResult>

export interface PrettierFileFormatterOptions {
  roots(): Promise<string[]>
  /** How a configuration Toucan cannot read statically is honoured anyway. */
  projectPrettier: ProjectPrettier
}

function ownerOf(path: string, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => isWithin(root, path))
    .sort((left, right) => resolve(right).length - resolve(left).length)[0]
}

/**
 * Formats file-node saves under one rule: a save either honours what the project actually said
 * about formatting, or it does not format at all. Never Prettier's defaults - a project whose
 * style Toucan could not determine is not a project that wants Prettier's opinions applied to it
 * by a one-character edit.
 *
 * There are two ways to honour it, in this order. Toucan's own bundled Prettier, driven by the
 * settings `prettier-project-config` read from disk, formats the common case in-process and
 * without spawning anything - but it can only be trusted with settings that are *data*, because
 * saving a file must never execute a repository's JavaScript configuration or formatter plugin in
 * the privileged main process. So where the project's configuration is code, or a format Toucan
 * has no reader for, the project's *own* Prettier runs it in a child process instead
 * (`project-prettier.ts`), which is both the only way to get the real answer and the only place
 * that code may run.
 *
 * Everything that is not a format is a pass-through with the content intact: an unsupported or
 * `.prettierignore`d file quietly; content Prettier cannot parse, or a configuration that neither
 * route could honour, with a warning the node shows beside the file.
 */
export function createPrettierFileFormatter(options: PrettierFileFormatterOptions): FileFormatter {
  return async (path, content, lineEnding = 'lf') => {
    try {
      const root = ownerOf(path, await options.roots())
      if (!root) return { content }
      const { config: configured, ignorePath, unreadable } = await projectFormatting(path, root)
      const info = await getFileInfo(path, { ignorePath, resolveConfig: false })
      if (info.ignored || !info.inferredParser) return { content }
      if (unreadable) {
        const ran = await options.projectPrettier({ path, content, root, lineEnding })
        if (ran.ok) return { content: ran.content }
        return { content, warning: savedUnformatted(`${unreadable}, and ${ran.reason}`) }
      }
      // Configuration can name executable plugins. Built-in Prettier support is deliberate;
      // opening and saving an untrusted checkout must not load its code into Toucan's main process.
      const { plugins: _plugins, ...config } = configured
      // `endOfLine` is the file's own, not the project's: a save preserves the file it opened,
      // and rewriting every line ending because the checkout's configuration disagrees with what
      // is on disk is exactly the whole-file rewrite a one-character edit must not become.
      const formatted = await format(content, {
        ...config,
        filepath: path,
        parser: info.inferredParser,
        endOfLine: lineEnding
      })
      return { content: formatted }
    } catch (error) {
      return { content, warning: (error as Error).message }
    }
  }
}
