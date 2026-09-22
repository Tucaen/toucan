import { resolve } from 'node:path'
import { format, getFileInfo } from 'prettier'
import type { LineEnding } from '../shared/line-endings'
import { projectFormatting } from './prettier-project-config'
import { isWithin } from './workspace-containment'

export interface FileFormatResult {
  content: string
  warning?: string
}

export type FileFormatter = (path: string, content: string, lineEnding?: LineEnding) => Promise<FileFormatResult>

export interface PrettierFileFormatterOptions {
  roots(): Promise<string[]>
}

function ownerOf(path: string, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => isWithin(root, path))
    .sort((left, right) => resolve(right).length - resolve(left).length)[0]
}

/**
 * Formats file-node saves with Toucan's bundled Prettier, under one rule: a save either honours
 * what the project actually said about formatting, or it does not format at all. Only static
 * configuration is read - saving a file must never execute a repository's JavaScript
 * configuration or formatter plugin in the privileged main process - and `prettier-project-config`
 * turns every name Prettier itself resolves into either settings or a refusal, so a project whose
 * style Toucan cannot read is never reformatted to Prettier's defaults behind the reader's back.
 *
 * Everything that is not a format is a pass-through with the content intact: an unsupported or
 * `.prettierignore`d file quietly, a configuration Toucan will not read or content Prettier
 * cannot parse with a warning the node shows beside the file.
 */
export function createPrettierFileFormatter(options: PrettierFileFormatterOptions): FileFormatter {
  return async (path, content, lineEnding = 'lf') => {
    try {
      const root = ownerOf(path, await options.roots())
      if (!root) return { content }
      const { config: configured, ignorePath, unreadable } = await projectFormatting(path, root)
      const info = await getFileInfo(path, { ignorePath, resolveConfig: false })
      if (info.ignored || !info.inferredParser) return { content }
      if (unreadable) return { content, warning: unreadable }
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
