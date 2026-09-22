/**
 * The one frontmatter reader and writer for Toucan's one-file-per-record Markdown collections
 * (brain-dump topics, tickets), and the reader behind showing any document's frontmatter to a
 * human. Deliberately not YAML: a flat `key: value` block, one field per
 * line, no nesting, no quoting rules of its own. Callers that need a richer value (a quoted
 * Windows path, a comma separated list) decode the raw string themselves, so this module stays
 * pure and dependency-free.
 *
 * It offers each operation in two strengths, because its two collections disagree about what a
 * file is. A brain-dump topic is a record Toucan wrote, so `parseFrontmatter` and
 * `rewriteFrontmatter` reject a block they cannot account for rather than guess at it. A ticket
 * file is a notepad anyone may have typed, so `lenientFrontmatter` and `upsertFrontmatter` take
 * what they can read, copy through what they cannot, and write a block where there is none. The
 * strictness is the *caller's* decision, which is why it is two pairs of functions and not a
 * flag: a module that had to be told each time would eventually be told wrong.
 *
 * Lenient is not unconditional, and the one condition is a *write* one: reading never fails, but
 * a write that would strand a field the file already carries is refused rather than performed
 * (see `upsertFrontmatter`). That refusal is in the return type rather than an exception, because
 * its caller has a diagnostic to show and nothing to retry.
 */

const FIELD = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/

/**
 * `FIELD` read as what it means, rather than as a match object indexed by number. Both groups are
 * unconditional, so a match always carries both - saying that once here is what lets every caller
 * below have a plain `string` key and value instead of its own non-null assertion.
 */
function readField(line: string): { key: string; value: string } | undefined {
  const match = FIELD.exec(line)
  if (!match) return undefined
  const [, key = '', value = ''] = match
  return { key, value }
}

/** The first line of a document, which `String.split` always yields even for empty input. */
function firstLine(lines: string[]): string {
  const [first = ''] = lines
  return first
}
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

/**
 * A `---` line, in a document split on `\n` alone. The optional carriage return is the whole
 * reason this is a pattern rather than a comparison: a file someone saved from a Windows editor
 * would otherwise have no frontmatter at all as far as this module is concerned, and a write
 * would then stack a second block on top of the one already there.
 */
const DELIMITER = /^---\r?$/

/**
 * The carriage return this document's lines carry, or nothing. Appended to every line this module
 * writes, so a block added to a CRLF file does not leave one line ending in the middle of it.
 */
function carriageReturn(lines: string[]): string {
  return lines.some((line) => line.endsWith('\r')) ? '\r' : ''
}

/** The delimiters alone, with no opinion about what is written between them. */
function findBlock(lines: string[]): Delimited | undefined {
  if (!DELIMITER.test(firstLine(lines))) return undefined
  const closing = lines.findIndex((line, index) => index > 0 && DELIMITER.test(line))
  return closing < 0 ? undefined : { lines, closing }
}

function readBlock(markdown: string, label: string): Block | { message: string } {
  const lines = markdown.split('\n')
  const delimited = findBlock(lines)
  if (!delimited) {
    if (!DELIMITER.test(firstLine(lines))) return { message: `${label} must start with YAML frontmatter.` }
    return { message: `${label} frontmatter must have a closing --- delimiter.` }
  }
  const closing = delimited.closing
  const fields = new Map<string, string>()
  for (const [offset, line] of lines.slice(1, closing).entries()) {
    const field = readField(line)
    if (!field) {
      if (IGNORABLE.test(line)) continue
      return { message: `Invalid frontmatter line ${offset + 2}.` }
    }
    if (fields.has(field.key)) return { message: `Duplicate frontmatter field "${field.key}".` }
    fields.set(field.key, field.value)
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
  return rewriteBlock(block, updates)
}

/** Shared by the strict and the lenient writer, so one rewrite decides how a block is edited. */
function rewriteBlock(block: Delimited, updates: Record<string, string | undefined>): string {
  const remaining = new Map(Object.entries(updates))
  const replaced = new Set<string>()
  const carriage = carriageReturn(block.lines)
  const output = [firstLine(block.lines)]
  for (const line of block.lines.slice(1, block.closing)) {
    const key = readField(line)?.key
    if (key && remaining.has(key)) {
      const value = remaining.get(key)
      if (value !== undefined) output.push(`${key}: ${value}${carriage}`)
      remaining.delete(key)
      replaced.add(key)
      continue
    }
    // A later duplicate of a key this rewrite just set would otherwise outlive the value it
    // replaced, leaving the file saying two things about one field.
    if (key && replaced.has(key)) continue
    output.push(line)
  }
  for (const [key, value] of remaining) if (value !== undefined) output.push(`${key}: ${value}${carriage}`)
  output.push(...block.lines.slice(block.closing))
  return output.join('\n')
}

/**
 * A delimited block that actually reads as frontmatter, with the fields it holds. A pair of `---`
 * lines is *not* enough: a note that opens with a horizontal rule has a pair too, and lifting the
 * prose between them out of the body would make it vanish from every surface that renders the
 * body. So a block with no readable field at all is prose, and these two say so together - if
 * only one of them believed it, a write would edit a block the read had never seen.
 */
function lenientBlock(lines: string[]): { fields: Map<string, string>; closing: number } | undefined {
  const delimited = findBlock(lines)
  if (!delimited) return undefined
  const fields = new Map<string, string>()
  for (const line of lines.slice(1, delimited.closing)) {
    const field = readField(line)
    if (field && !fields.has(field.key)) fields.set(field.key, field.value)
  }
  return fields.size > 0 ? { fields, closing: delimited.closing } : undefined
}

export type UpsertResult = { ok: true; markdown: string } | { ok: false; message: string }

/**
 * A block someone opened with `---`, wrote fields into, and never closed - the one document shape
 * this module will not write to. Prepending a block of its own would leave those fields below it
 * as prose: still in the file, but no longer read by anything, and out of reach of every later
 * write, which now edits the copy on top. Returns the first stranded key so the diagnostic can
 * name the line to fix rather than just the file.
 *
 * An unclosed opening with no field under it is a horizontal rule, and strands nothing. The scan
 * stops at the first line that is neither a field nor ignorable for the same reason: frontmatter
 * runs from the opening delimiter until something that is not frontmatter, so a note that starts
 * with a rule and writes `Note: call Bob` three paragraphs down is prose, not a record, and
 * refusing to move it would take leniency back with the other hand.
 */
function strandedField(lines: string[]): string | undefined {
  if (!DELIMITER.test(firstLine(lines)) || findBlock(lines)) return undefined
  for (const line of lines.slice(1)) {
    const field = readField(line)
    if (field) return field.key
    if (!IGNORABLE.test(line)) return undefined
  }
  return undefined
}

/**
 * Like `rewriteFrontmatter`, but a document with no block gets one written above the text it
 * already had, and a block this module could not parse strictly is edited anyway - lines it
 * cannot read are copied through untouched. For collections whose files are notepads first and
 * records second (tickets): refusing to write would make the board unable to move a card the
 * board is perfectly able to show.
 *
 * So strictness lives here rather than in the read, and it is down to one case: a document this
 * can neither edit nor safely write above (`strandedField`) is refused, and a caller that cannot
 * write is expected to say so rather than fall back to a write that loses a field.
 */
export function upsertFrontmatter(markdown: string, updates: Record<string, string | undefined>): UpsertResult {
  const lines = markdown.split('\n')
  const block = lenientBlock(lines)
  if (block) return { ok: true, markdown: rewriteBlock({ lines, closing: block.closing }, updates) }
  const stranded = strandedField(lines)
  if (stranded)
    return {
      ok: false,
      message: `Frontmatter opens with --- and sets "${stranded}" but has no closing --- delimiter. Add one above the body and try again.`
    }
  const fields = Object.entries(updates).flatMap(([key, value]) => (value === undefined ? [] : [`${key}: ${value}`]))
  const carriage = carriageReturn(lines)
  const written = ['---', ...fields, '---', ''].map((line) => `${line}${carriage}`)
  return { ok: true, markdown: [...written, markdown].join('\n') }
}

/**
 * Every `key: value` line of a closed block, and the body below it - never a failure. Unlike
 * `parseFrontmatter` a line that is not a field is skipped rather than rejected, and the first of
 * a duplicated key wins, because a file that cannot be read as a record is still a file with
 * something to show. No fields and the whole document as body when there is nothing this module
 * recognizes as frontmatter.
 */
export function lenientFrontmatter(markdown: string): ParsedFrontmatter {
  const lines = markdown.split('\n')
  const block = lenientBlock(lines)
  if (!block) return { ok: true, fields: new Map(), body: markdown }
  return { ok: true, fields: block.fields, body: lines.slice(block.closing + 1).join('\n') }
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
  for (const line of lines.slice(1, closing)) {
    const field = readField(line)
    if (field) {
      fields.push(field)
      continue
    }
    const content = line.trim()
    if (!content || content.startsWith('#')) continue
    const previous = fields.at(-1)
    if (!previous) continue
    previous.value = previous.value ? `${previous.value}\n${content}` : content
  }
  return { fields, body: lines.slice(closing + 1).join('\n') }
}
