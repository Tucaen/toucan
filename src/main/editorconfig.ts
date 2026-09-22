import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Options } from 'prettier'
import { directoriesUpTo, isWithin } from './workspace-containment'

/**
 * `.editorconfig` as Prettier reads it: the settings a project states for every editor, used as
 * the base a `.prettierrc` then overrides. Prettier's CLI honours it by default, so a file node
 * that ignored it would save a project's files at a width and indent nobody chose - and, unlike a
 * missing configuration file, an `.editorconfig` is usually the *only* thing a non-JavaScript
 * project states its style in.
 *
 * Only the keys Prettier has an option for are read. `end_of_line` is deliberately not one of
 * them: which ending a saved file gets is the file's own, decided in `file-view.ts`, because a
 * save preserves the file it opened rather than converting it to the project's stated preference.
 *
 * The search stops at the workspace root as well as at `root = true`, so a file node never reads
 * configuration from outside the checkout it belongs to.
 *
 * A file that is not there is not an answer to refuse - most projects have no `.editorconfig` at
 * all - but a file that is there and cannot be read *throws*, so the caller saves unformatted
 * rather than at Prettier's defaults. A line inside it that this reader does not recognise is
 * skipped, because that is what EditorConfig itself specifies for unknown properties.
 */
export async function editorConfigOptions(path: string, workspaceRoot: string): Promise<Options> {
  const found: Array<Map<string, string>> = []
  for (const directory of directoriesUpTo(path, workspaceRoot)) {
    const settings = await readEditorConfig(join(directory, '.editorconfig'), resolve(path))
    if (!settings) continue
    found.push(settings.options)
    if (settings.stop) break
  }
  // Nearest last: a setting stated closer to the file wins over the same setting further up.
  const merged = new Map<string, string>()
  for (const settings of found.reverse()) for (const [key, value] of settings) merged.set(key, value)
  return prettierOptions(merged)
}

interface EditorConfigFile {
  options: Map<string, string>
  /** `root = true`: the project says the search ends here. */
  stop: boolean
}

async function readEditorConfig(configPath: string, target: string): Promise<EditorConfigFile | undefined> {
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Only "there is no `.editorconfig` here" is silence. Anything else - unreadable, or a
    // directory wearing the name - is a project that meant to say something Toucan cannot read.
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  const directory = dirname(configPath)
  const options = new Map<string, string>()
  let stop = false
  let applies = false
  let preamble = true
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[(.*)]$/.exec(line)
    if (section) {
      preamble = false
      applies = matchesGlob(section[1], directory, target)
      continue
    }
    const pair = /^([^=]+)=(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1].trim().toLowerCase()
    const value = pair[2].trim()
    if (preamble) {
      if (key === 'root' && value.toLowerCase() === 'true') stop = true
      continue
    }
    if (applies) options.set(key, value.toLowerCase())
  }
  return { options, stop }
}

/**
 * EditorConfig's glob dialect, against the target's path relative to the `.editorconfig`. A
 * pattern with no `/` matches the name in any subdirectory, a leading `/` anchors to this
 * directory, `*` stops at a separator and `**` does not.
 */
function matchesGlob(pattern: string, directory: string, target: string): boolean {
  const between = relative(directory, target)
  if (!isWithin(directory, target)) return false
  const subject = between.split(sep).join('/')
  const anchored = pattern.includes('/') ? pattern.replace(/^\//, '') : `**/${pattern}`
  return new RegExp(`^${globSource(anchored)}$`).test(subject)
}

function globSource(pattern: string): string {
  let source = ''
  for (let at = 0; at < pattern.length; at += 1) {
    const here = pattern[at]
    if (here === '*' && pattern[at + 1] === '*') {
      // `**/` must also match no directory at all, so `**/*.ts` covers a file beside the config.
      if (pattern[at + 2] === '/') {
        source += '(?:.*/)?'
        at += 2
      } else {
        source += '.*'
        at += 1
      }
    } else if (here === '*') source += '[^/]*'
    else if (here === '?') source += '[^/]'
    else if (here === '{') source += '(?:'
    else if (here === '}') source += ')'
    else if (here === ',') source += '|'
    else if (here === '[') source += '['
    else if (here === ']') source += ']'
    else if (here === '!' && pattern[at - 1] === '[') source += '^'
    else source += here.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return source
}

function prettierOptions(settings: Map<string, string>): Options {
  const options: Options = {}
  const indentStyle = settings.get('indent_style')
  if (indentStyle === 'tab') options.useTabs = true
  else if (indentStyle === 'space') options.useTabs = false

  // `indent_size = tab` is EditorConfig's way of saying "whatever a tab is here", so it falls
  // through to `tab_width`.
  const indentWidth = Number(settings.get('indent_size'))
  const tabWidth = Number(settings.get('tab_width'))
  if (Number.isInteger(indentWidth) && indentWidth > 0) options.tabWidth = indentWidth
  else if (Number.isInteger(tabWidth) && tabWidth > 0) options.tabWidth = tabWidth

  const maxLineLength = Number(settings.get('max_line_length'))
  if (Number.isInteger(maxLineLength) && maxLineLength > 0) options.printWidth = maxLineLength

  const quoteType = settings.get('quote_type')
  if (quoteType === 'single') options.singleQuote = true
  else if (quoteType === 'double') options.singleQuote = false
  return options
}
