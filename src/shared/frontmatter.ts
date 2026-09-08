/**
 * The one frontmatter reader and writer for Toucan's one-file-per-record Markdown collections
 * (brain-dump topics, tickets), and the reader behind showing any document's frontmatter to a
 * human. Deliberately not YAML: a flat `key: value` block, one field per
 * line, no nesting, no quoting rules of its own. Callers that need a richer value (a quoted
 * Windows path, a comma separated list) decode the raw string themselves, so this module stays
 * pure and dependency-free.
 */

const FIELD = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/
/** A blank line or a `#` comment inside the block: present for humans, no field to read. */
const IGNORABLE = /^(?:\s|#|$)/

export interface ParsedFrontmatter {
  ok: true
  /** Insertion-ordered so a caller can reproduce the block it read. */
  fields: Map<string, string>
  /** Everything after the closing delimiter line, verbatim. */
  body: string
}

export type FrontmatterResult = ParsedFrontmatter | { ok: false; message: string }

interface Block {
  fields: Map<string, string>
  lines: string[]
  closing: number
}

interface Delimited {
  lines: string[]
  /** Index of the closing `---`; the block is the lines between it and line 0. */
  closing: number
}

/** The delimiters alone, with no opinion about what is written between them. */
function findBlock(lines: string[]): Delimited | undefined {
  if (lines[0] !== '---') return undefined
  const closing = lines.indexOf('---', 1)
  return closing < 0 ? undefined : { lines, closing }
}

function readBlock(markdown: string, label: string): Block | { message: string } {
  const lines = markdown.split('\n')
  const delimited = findBlock(lines)
  if (!delimited) {
    if (lines[0] !== '---') return { message: `${label} must start with YAML frontmatter.` }
    return { message: `${label} frontmatter must have a closing --- delimiter.` }
  }
  const closing = delimited.closing
  const fields = new Map<string, string>()
  for (let index = 1; index < closing; index += 1) {
    const match = FIELD.exec(lines[index])
    if (!match) {
      if (IGNORABLE.test(lines[index])) continue
      return { message: `Invalid frontmatter line ${index + 1}.` }
    }
    if (fields.has(match[1])) return { message: `Duplicate frontmatter field "${match[1]}".` }
    fields.set(match[1], match[2])
  }
  return { fields, lines, closing }
}

/**
 * `label` names what the file was meant to be ("Topic", "Ticket") so a diagnostic row reads as
 * the collection's own, rather than every collection reporting the same anonymous error.
 */
export function parseFrontmatter(markdown: string, label = 'Document'): FrontmatterResult {
  const block = readBlock(markdown, label)
  if ('message' in block) return { ok: false, message: block.message }
  return { ok: true, fields: block.fields, body: block.lines.slice(block.closing + 1).join('\n') }
}

/**
 * Returns `markdown` with each named field set, or removed when its update is `undefined`. Fields
 * that already exist keep their position; new ones are appended just above the closing delimiter.
 * The body is copied through untouched, so a rewrite never reflows or reinterprets prose.
 *
 * Throws when there is no frontmatter to rewrite: inventing a block would fabricate a record shape
 * the caller never validated.
 */
export function rewriteFrontmatter(markdown: string, updates: Record<string, string | undefined>): string {
  const block = readBlock(markdown, 'Document')
  if ('message' in block) throw new Error(block.message)
  const remaining = new Map(Object.entries(updates))
  const output = [block.lines[0]]
  for (let index = 1; index < block.closing; index += 1) {
    const key = FIELD.exec(block.lines[index])?.[1]
    if (key && remaining.has(key)) {
      const value = remaining.get(key)
      if (value !== undefined) output.push(`${key}: ${value}`)
      remaining.delete(key)
    } else output.push(block.lines[index])
  }
  for (const [key, value] of remaining) if (value !== undefined) output.push(`${key}: ${value}`)
  output.push(...block.lines.slice(block.closing))
  return output.join('\n')
}

export interface FrontmatterField {
  key: string
  /** Continuation lines are joined by newlines, so a nested list keeps the shape it was written in. */
  value: string
}

export interface DisplayedFrontmatter {
  /** Ordered as written, so the block reads the way it does on disk. */
  fields: FrontmatterField[]
  /** Everything after the closing delimiter line, verbatim. */
  body: string
}

/**
 * The frontmatter block as a reader should see it, plus the body it sits above. Unlike
 * `parseFrontmatter` this never fails on shape: to a viewer a nested, repeated or unparseable line
 * is content to show, not a record to reject, so every document renders. A line that is not
 * `key: value` continues the field above it, which is how a nested list stays attached to its key.
 * `undefined` means there is no closed block to lift out, and the whole document is body.
 */
export function frontmatterForDisplay(markdown: string): DisplayedFrontmatter | undefined {
  const delimited = findBlock(markdown.split('\n'))
  if (!delimited) return undefined
  const { lines, closing } = delimited
  const fields: FrontmatterField[] = []
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index]
    const match = FIELD.exec(line)
    if (match) {
      fields.push({ key: match[1], value: match[2] })
      continue
    }
    const content = line.trim()
    if (!content || content.startsWith('#')) continue
    const previous = fields[fields.length - 1]
    if (!previous) continue
    previous.value = previous.value ? `${previous.value}\n${content}` : content
  }
  return { fields, body: lines.slice(closing + 1).join('\n') }
}
