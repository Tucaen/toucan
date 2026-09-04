/**
 * The one frontmatter reader and writer for Toucan's one-file-per-record Markdown collections
 * (brain-dump topics, tickets). Deliberately not YAML: a flat `key: value` block, one field per
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

function readBlock(markdown: string, label: string): Block | { message: string } {
  const lines = markdown.split('\n')
  if (lines[0] !== '---') return { message: `${label} must start with YAML frontmatter.` }
  const closing = lines.indexOf('---', 1)
  if (closing < 0) return { message: `${label} frontmatter must have a closing --- delimiter.` }
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
