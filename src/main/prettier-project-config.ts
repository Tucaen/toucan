import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Options } from 'prettier'
import { editorConfigOptions } from './editorconfig'
import { parseFlatYaml, parseJson5 } from './static-config'
import { directoriesUpTo } from './workspace-containment'

/**
 * What a file's project says about formatting it, read from disk and nothing else. This is the
 * half of format-on-save that has to be exhaustive: Prettier's own resolver knows a dozen
 * configuration file names, and a name Toucan did not look for is not a project without settings
 * - it is a project whose settings are about to be replaced by Prettier's defaults, silently, on
 * a one-character save.
 *
 * So every name Prettier reads is listed here, and each is either read or *refused by name*.
 * Refused covers the executable forms (`.prettierrc.js`, `prettier.config.ts`, ...), which a
 * privileged main process must not run for an untrusted checkout, and `.prettierrc.toml`, which
 * Toucan has no reader for. A refusal is not silence: it names itself, so `file-formatter.ts` can
 * hand those settings to the project's own Prettier instead, and only tell the reader the file
 * went through unformatted once that has failed too. What it must never do is fall through to
 * Prettier's defaults, because formatting with defaults is the damage.
 */
export interface ProjectFormatting {
  /** Prettier options to format with, `.editorconfig` underneath the project's Prettier file. */
  config: Options
  /** The nearest `.prettierignore`, if the project has one. */
  ignorePath?: string
  /**
   * A configuration file exists but was not read, as a clause naming it: "`X` is configuration
   * Toucan does not read". Not a finished sentence, because what happens next is not this
   * module's to say - the caller can still honour those settings by running the project's own
   * Prettier, and only it knows whether that worked. `savedUnformatted` is how it ends the
   * sentence when it did not.
   */
  unreadable?: string
}

/** `package.json` without a `prettier` key is not this project's Prettier configuration. */
const NOT_CONFIGURED = Symbol('no prettier key')

type Reader = (text: string) => Options | typeof NOT_CONFIGURED

/** Every name Prettier itself resolves, in Prettier's own order. Keep this list in that order. */
const CONFIG_NAMES: ReadonlyArray<readonly [name: string, read: Reader | null]> = [
  ['package.json', packageJsonConfig],
  ['package.yaml', packageYamlConfig],
  ['.prettierrc', jsonOrYaml],
  ['.prettierrc.json', json5Config],
  ['.prettierrc.yml', yamlConfig],
  ['.prettierrc.yaml', yamlConfig],
  ['.prettierrc.json5', json5Config],
  ['.prettierrc.js', null],
  ['prettier.config.js', null],
  ['.prettierrc.ts', null],
  ['prettier.config.ts', null],
  ['.prettierrc.mjs', null],
  ['prettier.config.mjs', null],
  ['.prettierrc.mts', null],
  ['prettier.config.mts', null],
  ['.prettierrc.cjs', null],
  ['prettier.config.cjs', null],
  ['.prettierrc.cts', null],
  ['prettier.config.cts', null],
  ['.prettierrc.toml', null]
]

/** The one sentence a reader sees when their project's settings could not be honoured. */
export function savedUnformatted(reason: string): string {
  return `${reason}, so this file was saved exactly as you typed it.`
}

export async function projectFormatting(path: string, root: string): Promise<ProjectFormatting> {
  let ignorePath: string | undefined
  let found: Options | undefined
  let unreadable: string | undefined
  for (const directory of directoriesUpTo(path, root)) {
    ignorePath ??= (await existing(join(directory, '.prettierignore'))) ? join(directory, '.prettierignore') : undefined
    // The nearest configuration decides; the walk continues only because a `.prettierignore`
    // further up still applies to this file.
    if (found || unreadable) continue
    for (const [name, read] of CONFIG_NAMES) {
      const candidate = join(directory, name)
      if (!(await existing(candidate))) continue
      if (!read) {
        unreadable = `${name} is configuration Toucan does not read`
        break
      }
      const parsed = await readConfig(candidate, read)
      if (parsed === NOT_CONFIGURED) continue
      if (typeof parsed === 'string') {
        unreadable = `${name} could not be read (${parsed})`
        break
      }
      found = parsed
      break
    }
  }
  if (unreadable) return { config: {}, ignorePath, unreadable }
  // `.editorconfig` is the base Prettier itself gives it: what the project states for every
  // editor, overridden key by key by what it states for Prettier - and one that exists but cannot
  // be read stops the save being formatted, exactly as an unreadable Prettier file does.
  let editorConfig: Options
  try {
    editorConfig = await editorConfigOptions(path, root)
  } catch (error) {
    return {
      config: {},
      ignorePath,
      unreadable: `.editorconfig could not be read (${(error as Error).message})`
    }
  }
  return { config: { ...editorConfig, ...found }, ignorePath }
}

async function readConfig(path: string, read: Reader): Promise<Options | typeof NOT_CONFIGURED | string> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return (error as Error).message
  }
  try {
    return read(text)
  } catch (error) {
    return (error as Error).message
  }
}

async function existing(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function asOptions(parsed: unknown, what: string): Options {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} is not a list of settings`)
  }
  return parsed as Options
}

function json5Config(text: string): Options {
  return asOptions(parseJson5(text), 'the file')
}

function yamlConfig(text: string): Options {
  return parseFlatYaml(text) as Options
}

/** Extension-less, so the file itself says which of the two it is - by parsing as one of them. */
function jsonOrYaml(text: string): Options {
  if (text.trimStart().startsWith('{')) return json5Config(text)
  return yamlConfig(text)
}

/**
 * A `package.yaml` states its Prettier settings as a nested mapping, which the flat reader cannot
 * account for - so one that has a `prettier:` block is refused by name, and one that has none is
 * simply not this project's configuration.
 */
function packageYamlConfig(text: string): Options | typeof NOT_CONFIGURED {
  if (!/^prettier:/m.test(text)) return NOT_CONFIGURED
  throw new Error('its "prettier" block is nested YAML')
}

function packageJsonConfig(text: string): Options | typeof NOT_CONFIGURED {
  const parsed = asOptions(JSON.parse(text) as unknown, 'package.json')
  const prettier = (parsed as Record<string, unknown>).prettier
  if (prettier === undefined) return NOT_CONFIGURED
  return asOptions(prettier, 'the package.json "prettier" field')
}
