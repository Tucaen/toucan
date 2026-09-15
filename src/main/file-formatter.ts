import { access, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { format, getFileInfo, type Options } from 'prettier'

export interface FileFormatResult {
  content: string
  warning?: string
}

export type FileFormatter = (path: string, content: string) => Promise<FileFormatResult>

export interface PrettierFileFormatterOptions {
  roots(): Promise<string[]>
}

const CONFIG_NAMES = ['.prettierrc.json', 'package.json'] as const

function contains(root: string, path: string): boolean {
  const rest = relative(resolve(root), resolve(path))
  return (
    rest === '' ||
    (rest !== '..' && !rest.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rest))
  )
}

async function existing(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function jsonConfig(path: string): Promise<Options | null> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  if (path.endsWith('package.json')) {
    const prettier = (parsed as Record<string, unknown>).prettier
    return typeof prettier === 'object' && prettier !== null && !Array.isArray(prettier) ? (prettier as Options) : null
  }
  return parsed as Options
}

async function projectFiles(path: string, root: string): Promise<{ config: Options; ignorePath?: string }> {
  let directory = dirname(resolve(path))
  const boundary = resolve(root)
  let ignorePath: string | undefined
  let config: Options | undefined
  while (contains(boundary, directory)) {
    ignorePath ??= (await existing(join(directory, '.prettierignore'))) ? join(directory, '.prettierignore') : undefined
    if (!config) {
      for (const name of CONFIG_NAMES) {
        const candidate = join(directory, name)
        if (!(await existing(candidate))) continue
        config = (await jsonConfig(candidate)) ?? undefined
        if (config) break
      }
    }
    if (directory === boundary) break
    directory = dirname(directory)
  }
  return { config: config ?? {}, ignorePath }
}

function ownerOf(path: string, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => contains(root, path))
    .sort((left, right) => resolve(right).length - resolve(left).length)[0]
}

/**
 * Formats file-node saves with Toucan's bundled Prettier. Only static JSON configuration is read:
 * saving a file must never execute a repository's JavaScript configuration or formatter plugin
 * in the privileged main process. Unsupported and ignored files pass through unchanged. A parse
 * or configuration error also leaves the content intact and gives the renderer a warning.
 */
export function createPrettierFileFormatter(options: PrettierFileFormatterOptions): FileFormatter {
  return async (path, content) => {
    try {
      const root = ownerOf(path, await options.roots())
      if (!root) return { content }
      const { config: configured, ignorePath } = await projectFiles(path, root)
      const info = await getFileInfo(path, { ignorePath, resolveConfig: false })
      if (info.ignored || !info.inferredParser) return { content }
      // JSON configuration can name executable plugins. Built-in Prettier support is deliberate;
      // opening and saving an untrusted checkout must not load its code into Toucan's main process.
      const { plugins: _plugins, ...config } = configured
      const formatted = await format(content, { ...config, filepath: path, parser: info.inferredParser })
      return { content: formatted }
    } catch (error) {
      return { content, warning: (error as Error).message }
    }
  }
}
