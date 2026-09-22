/**
 * Reads the two shapes a Prettier configuration file is written in without running any of it.
 * Prettier's own loader executes JavaScript and TypeScript configuration, which a privileged main
 * process opening an untrusted checkout must never do - so Toucan brings its own readers for the
 * static forms and refuses the rest.
 *
 * Both readers are deliberately narrow and both *throw* rather than guess: the caller turns a
 * refusal into "saved unformatted, here is why", which is the only honest answer when a project
 * plainly stated a setting Toucan could not read. Formatting such a file with Prettier's defaults
 * instead would rewrite it to a style nobody asked for and report success.
 */

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y
const NUMBER = /[-+]?(?:0[xX][0-9a-fA-F]+|Infinity|NaN|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y

/**
 * JSON, and the JSON5 a `.prettierrc.json5` may use: comments, trailing commas, single quotes and
 * unquoted keys. Written out rather than delegated to `JSON.parse` after a textual clean-up,
 * because stripping comments without tracking string state corrupts any setting whose value
 * contains `//` - a glob, a URL, a Windows path.
 */
export function parseJson5(text: string): unknown {
  let at = 0

  const fail = (what: string): never => {
    const line = text.slice(0, at).split('\n').length
    throw new Error(`${what} on line ${line}.`)
  }

  const skip = (): void => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at])) at += 1
      if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at)
        at = end < 0 ? text.length : end
      } else if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2)
        if (end < 0) fail('An unclosed block comment starts')
        at = end + 2
      } else return
    }
  }

  const string = (): string => {
    const quote = text[at]
    at += 1
    let value = ''
    while (at < text.length && text[at] !== quote) {
      if (text[at] !== '\\') {
        value += text[at]
        at += 1
        continue
      }
      at += 1
      const escape = text[at]
      at += 1
      if (escape === 'u') {
        value += String.fromCharCode(Number.parseInt(text.slice(at, at + 4), 16))
        at += 4
      } else if (escape === '\n') continue
      else value += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }[escape] ?? escape
    }
    if (at >= text.length) fail('An unterminated string starts')
    at += 1
    return value
  }

  const matched = (pattern: RegExp): string | null => {
    pattern.lastIndex = at
    const found = pattern.exec(text)
    if (!found) return null
    at = pattern.lastIndex
    return found[0]
  }

  const value = (): unknown => {
    skip()
    const here = text[at]
    if (here === '{') {
      at += 1
      const object: Record<string, unknown> = {}
      skip()
      while (text[at] !== '}') {
        if (at >= text.length) fail('An unclosed object starts')
        skip()
        const key =
          text[at] === '"' || text[at] === "'" ? string() : (matched(IDENTIFIER) ?? fail('Expected a setting name'))
        skip()
        if (text[at] !== ':') fail(`Expected ':' after '${key}'`)
        at += 1
        object[key] = value()
        skip()
        if (text[at] === ',') {
          at += 1
          skip()
        } else break
      }
      if (text[at] !== '}') fail('An unclosed object starts')
      at += 1
      return object
    }
    if (here === '[') {
      at += 1
      const array: unknown[] = []
      skip()
      while (text[at] !== ']') {
        if (at >= text.length) fail('An unclosed list starts')
        array.push(value())
        skip()
        if (text[at] === ',') {
          at += 1
          skip()
        } else break
      }
      if (text[at] !== ']') fail('An unclosed list starts')
      at += 1
      return array
    }
    if (here === '"' || here === "'") return string()
    for (const [word, literal] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ] as const) {
      if (text.startsWith(word, at) && !/[A-Za-z0-9_$]/.test(text[at + word.length] ?? '')) {
        at += word.length
        return literal
      }
    }
    const number = matched(NUMBER)
    if (number === null) return fail('Expected a value')
    return Number(number)
  }

  const parsed = value()
  skip()
  if (at < text.length) fail('Unexpected text')
  return parsed
}

/**
 * A `.prettierrc` written as YAML: one `key: value` per line, nothing nested. That covers every
 * Prettier setting except `overrides`, and a file that uses more than this is refused rather than
 * read in part - honouring half of what a project asked for is worse than honouring none of it,
 * because only the half that was dropped rewrites the file.
 */
export function parseFlatYaml(text: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trimStart().startsWith('#') || line.trim() === '---') continue
    const found = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line)
    if (!found) {
      throw new Error(`Line ${index + 1} is not a plain 'setting: value' line, which is all Toucan reads here.`)
    }
    const [, key, rest = ''] = found
    const scalar = rest.replace(/\s+#.*$/, '').trim()
    if (!scalar) throw new Error(`'${key}' on line ${index + 1} has no value on its own line.`)
    settings[key] = yamlScalar(scalar)
  }
  return settings
}

function yamlScalar(scalar: string): unknown {
  if (scalar.startsWith('"') || scalar.startsWith("'")) {
    if (scalar.length < 2 || !scalar.endsWith(scalar[0])) throw new Error(`The quoted value ${scalar} is not closed.`)
    return scalar.slice(1, -1)
  }
  if (scalar === 'true' || scalar === 'yes' || scalar === 'on') return true
  if (scalar === 'false' || scalar === 'no' || scalar === 'off') return false
  if (scalar === 'null' || scalar === '~') return null
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(scalar)) return Number(scalar)
  if (scalar.startsWith('[') || scalar.startsWith('{') || scalar.startsWith('&') || scalar.startsWith('*')) {
    throw new Error(`The value ${scalar} is more than the plain settings Toucan reads here.`)
  }
  return scalar
}
