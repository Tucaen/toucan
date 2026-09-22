import type { AgentActivity } from '../../shared/agent'
import { pathWithinRoot } from '../../shared/paths'
import { diffLines } from 'diff'
import { asRecord, asText, memoizePerActivity, normalizeToolName } from './tool-input'

/**
 * The file operations that get a purpose-built card. Everything else keeps the generic card, so
 * this list is deliberately the set of tools whose arguments we know how to read.
 */
export type FileOperationKind = 'read' | 'write' | 'edit' | 'multi-edit' | 'notebook-edit'

export interface FileOperationEdit {
  oldText: string
  newText: string
}

export interface FileOperationDiff extends FileOperationEdit {
  path: string
}

/**
 * What a file-operation card needs to know, recovered from whatever the adapter actually sent.
 * `path` is kept exactly as reported (absolute, native separators) because that is the string a
 * reader copies or reveals; shortening is a rendering concern - see `shortenFilePath`.
 */
export interface FileOperation {
  kind: FileOperationKind
  path: string
  /** 1-based inclusive line range, only for a read that asked for one. */
  range?: { start: number; end?: number }
  /** The payload a write or a notebook edit put on disk. */
  content?: string
  edits?: FileOperationEdit[]
  /** Full-file before/after payloads reported by ACP; several entries form one grouped card. */
  diffs?: FileOperationDiff[]
  cell?: string
  editMode?: string
}

export interface FileOperationLine {
  /** The file line this text sits on, where the operation knows it. */
  number?: number
  oldNumber?: number
  newNumber?: number
  text: string
  tone?: 'old' | 'new'
}

/** One labelled run of lines - a read excerpt, a write preview, or one edit's before/after. */
export interface FileOperationBlock {
  label?: string
  path?: string
  languagePath?: string
  lines: FileOperationLine[]
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function editsFromRawInput(input: Record<string, unknown>): FileOperationEdit[] | undefined {
  const list = input.edits
  if (Array.isArray(list)) {
    const edits = list.flatMap((entry) => {
      const edit = asRecord(entry)
      if (!edit) return []
      const oldText = typeof edit.old_string === 'string' ? edit.old_string : ''
      const newText = typeof edit.new_string === 'string' ? edit.new_string : ''
      return oldText || newText ? [{ oldText, newText }] : []
    })
    if (edits.length > 0) return edits
  }
  const oldText = typeof input.old_string === 'string' ? input.old_string : undefined
  const newText = typeof input.new_string === 'string' ? input.new_string : undefined
  if (oldText === undefined && newText === undefined) return undefined
  return [{ oldText: oldText ?? '', newText: newText ?? '' }]
}

function editsFromDiffs(activity: AgentActivity, path: string): FileOperationEdit[] | undefined {
  const diffs = activity.diffs?.filter((diff) => diff.path === path)
  if (!diffs?.length) return undefined
  return diffs.map((diff) => ({ oldText: diff.oldText ?? '', newText: diff.newText }))
}

function readRange(input: Record<string, unknown>): FileOperation['range'] {
  const offset = asNumber(input.offset)
  const limit = asNumber(input.limit)
  if (offset === undefined && limit === undefined) return undefined
  const start = offset ?? 1
  return limit === undefined ? { start } : { start, end: start + limit - 1 }
}

/**
 * Recognizes a file-touching tool call from what the adapter reported, preferring the tool's own
 * name and arguments and falling back to the shape of `rawInput`, then to ACP's kind plus
 * location. Returns `null` for anything whose card would be guessing - a command, a search, or a
 * file tool that named no file at all - so those keep the generic card rather than a card that
 * leads with a path it does not have.
 * @internal exported for tests
 */
export function parseFileOperation(activity: AgentActivity): FileOperation | null {
  const input = asRecord(activity.rawInput) ?? {}
  const name = normalizeToolName(activity.toolName)
  const notebookPath = asText(input.notebook_path) ?? asText(input.notebookPath)
  const path =
    asText(input.file_path) ??
    asText(input.filePath) ??
    notebookPath ??
    (name || activity.kind === 'read' || activity.kind === 'edit' ? activity.locations?.[0] : undefined) ??
    activity.diffs?.[0]?.path
  if (!path) return null

  if (name === 'notebookedit' || (!name && notebookPath)) {
    const cell = asText(input.cell_id) ?? asText(input.cellId)
    const editMode = asText(input.edit_mode) ?? asText(input.editMode)
    const source = asText(input.new_source) ?? asText(input.newSource)
    return {
      kind: 'notebook-edit',
      path,
      ...(cell ? { cell } : {}),
      ...(editMode ? { editMode } : {}),
      ...(source !== undefined ? { content: source } : {})
    }
  }

  const edits = editsFromRawInput(input) ?? editsFromDiffs(activity, path)
  const diffs = activity.diffs?.map((diff) => ({
    path: diff.path,
    oldText: diff.oldText ?? '',
    newText: diff.newText
  }))
  const content = asText(input.content)
  const range = readRange(input)

  if (name === 'read') return { kind: 'read', path, ...(range ? { range } : {}) }
  if (name === 'write')
    return {
      kind: 'write',
      path,
      ...(content !== undefined ? { content } : {}),
      ...(diffs ? { diffs } : {})
    }
  if (name === 'multiedit') return { kind: 'multi-edit', path, edits: edits ?? [] }
  if (name === 'edit') return { kind: 'edit', path, ...(edits ? { edits } : {}), ...(diffs ? { diffs } : {}) }

  // No usable name: the arguments say what happened, and failing those, ACP's kind does. A
  // A payload identifies a Write even when the adapter omits its name; retain any ACP diff so the
  // card can show proof of the change rather than falling back to the payload-only preview.
  if (content !== undefined) return { kind: 'write', path, content, ...(diffs ? { diffs } : {}) }
  if (diffs) return { kind: 'edit', path, edits, diffs }
  if (edits) return { kind: edits.length > 1 ? 'multi-edit' : 'edit', path, edits }
  if (activity.kind === 'read') return { kind: 'read', path, ...(range ? { range } : {}) }
  if (activity.kind === 'edit') return { kind: 'edit', path }
  return null
}

/** `parseFileOperation` for the render path, cached per activity object (`memoizePerActivity`). */
export const fileOperationFor = memoizePerActivity(parseFileOperation)

/**
 * Renders a path relative to the deepest root that contains it, so a card reads `src/a.ts`
 * rather than a full absolute path the reader has to scan. Comparison is separator- and
 * case-insensitive because the same checkout reaches an agent under either drive-letter case and
 * either slash. A file under no root keeps its full path - a relative-looking path for a file
 * that is not in the workspace would be a lie.
 */
export function shortenFilePath(path: string, roots: readonly (string | undefined)[]): string {
  const normalized = path.replace(/\\/g, '/')
  let shortest: string | undefined
  for (const root of roots) {
    if (!root) continue
    const relative = pathWithinRoot(path, root)
    if (!relative) continue
    if (shortest === undefined || relative.length < shortest.length) shortest = relative
  }
  return shortest ?? normalized
}

/** The summary line's path, with the range appended for a read that asked for one. */
export function fileOperationLabel(operation: FileOperation, roots: readonly (string | undefined)[]): string {
  const path = shortenFilePath(operation.path, roots)
  const range = operation.range
  if (!range) return path
  return range.end === undefined ? `${path}:${range.start}` : `${path}:${range.start}-${range.end}`
}

const NUMBERED_LINE = /^\s*(\d+)(?:\t|→|:\s)(.*)$/

/**
 * Agents hand back read output either as plain file text or already numbered (`  12\ttext`).
 * Numbering a numbered excerpt again would produce two columns of numbers, so an excerpt that is
 * already numbered keeps the agent's numbers and the rest are counted from the range's start.
 */
function readExcerptLines(text: string, startLine: number): FileOperationLine[] {
  const lines = text.split('\n')
  const matches = lines.map((line) => NUMBERED_LINE.exec(line))
  const numbered = matches.filter(Boolean).length
  if (numbered > 0 && numbered >= Math.ceil(lines.filter((line) => line.trim()).length / 2)) {
    return lines.map((line, index) => {
      const match = matches[index]
      return match ? { number: Number(match[1]), text: match[2] } : { text: line }
    })
  }
  return lines.map((line, index) => ({ number: startLine + index, text: line }))
}

function previewLines(text: string): FileOperationLine[] {
  return text.split('\n').map((line, index) => ({ number: index + 1, text: line }))
}

function editBlockLines(edit: FileOperationEdit): FileOperationLine[] {
  const before: FileOperationLine[] = edit.oldText
    ? edit.oldText.split('\n').map((text) => ({ text, tone: 'old' as const }))
    : []
  const after: FileOperationLine[] = edit.newText
    ? edit.newText.split('\n').map((text) => ({ text, tone: 'new' as const }))
    : []
  return [...before, ...after]
}

const DIFF_CONTEXT_LINES = 3

function changedFileLines(diff: FileOperationDiff): FileOperationLine[] {
  let oldNumber = 1
  let newNumber = 1
  const rows: FileOperationLine[] = []
  for (const change of diffLines(diff.oldText, diff.newText)) {
    const lines = change.value.replace(/\n$/, '').split('\n')
    if (lines.length === 1 && lines[0] === '' && change.value === '') continue
    for (const text of lines) {
      if (change.removed) {
        rows.push({ oldNumber, text, tone: 'old' })
        oldNumber += 1
      } else if (change.added) {
        rows.push({ newNumber, text, tone: 'new' })
        newNumber += 1
      } else {
        rows.push({ oldNumber, newNumber, text })
        oldNumber += 1
        newNumber += 1
      }
    }
  }
  return rows
}

function hunkRangeLabel(lines: FileOperationLine[]): string {
  const old = lines.flatMap((line) => (line.oldNumber === undefined ? [] : [line.oldNumber]))
  const next = lines.flatMap((line) => (line.newNumber === undefined ? [] : [line.newNumber]))
  const oldStart = old[0] ?? (next[0] ?? 1) - 1
  const newStart = next[0] ?? (old[0] ?? 1) - 1
  return `@@ -${oldStart},${old.length} +${newStart},${next.length} @@`
}

/** Turns a full-file before/after into merged changed hunks with three context lines. */
function diffBlocks(diff: FileOperationDiff): FileOperationBlock[] {
  const rows = changedFileLines(diff)
  const changed = rows.flatMap((line, index) => (line.tone ? [index] : []))
  if (changed.length === 0) return []
  const ranges: Array<{ start: number; end: number }> = []
  for (const index of changed) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES)
    const end = Math.min(rows.length, index + DIFF_CONTEXT_LINES + 1)
    const previous = ranges.at(-1)
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }
  return ranges.map(({ start, end }) => {
    const lines = rows.slice(start, end)
    return { path: diff.path, languagePath: diff.path, label: hunkRangeLabel(lines), lines }
  })
}

/**
 * The body of a file card, as data: a read is its excerpt with line numbers, a write is a size
 * and a preview rather than the whole payload, and an edit is a compact before/after per edit.
 * Kept separate from the JSX so what a card shows is testable without a DOM.
 */
export function fileOperationBlocks(operation: FileOperation, content: string | undefined): FileOperationBlock[] {
  if (operation.diffs?.length) return operation.diffs.flatMap(diffBlocks)
  switch (operation.kind) {
    case 'read': {
      if (!content) return []
      return [{ languagePath: operation.path, lines: readExcerptLines(content, operation.range?.start ?? 1) }]
    }
    case 'write':
    case 'notebook-edit': {
      const payload = operation.content
      if (payload === undefined) return content ? [{ lines: previewLines(content) }] : []
      const lines = previewLines(payload)
      const size = `${formatByteSize(byteLength(payload))} · ${lines.length} lines`
      const label = operation.kind === 'notebook-edit' ? `${notebookCellLabel(operation)} · ${size}` : size
      return [{ label, languagePath: operation.path, lines: lines.map((line) => ({ ...line, tone: 'new' })) }]
    }
    case 'edit':
    case 'multi-edit': {
      const edits = operation.edits ?? []
      if (edits.length === 0) return content ? [{ lines: previewLines(content) }] : []
      return edits.map((edit, index) => ({
        languagePath: operation.path,
        ...(edits.length > 1 ? { label: `Edit ${index + 1} of ${edits.length}` } : {}),
        lines: editBlockLines(edit)
      }))
    }
  }
}

function notebookCellLabel(operation: FileOperation): string {
  const mode = operation.editMode ? ` (${operation.editMode})` : ''
  return operation.cell ? `Cell ${operation.cell}${mode}` : `Notebook cell${mode}`
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Bounds what reaches the DOM the way the shell expects (see `truncateToolOutput`): lines are
 * handed out block by block until the budget runs out, a block left with nothing is dropped
 * rather than rendered as an empty heading, and the remainder is counted so "show more" can be
 * honest about it.
 */
export function clampFileOperationBlocks(
  blocks: FileOperationBlock[],
  budget: number | null
): { blocks: FileOperationBlock[]; hiddenLines: number } {
  if (budget === null) return { blocks, hiddenLines: 0 }
  const kept: FileOperationBlock[] = []
  let remaining = Math.max(0, budget)
  let hiddenLines = 0
  for (const block of blocks) {
    if (remaining <= 0) {
      hiddenLines += block.lines.length
      continue
    }
    const lines = block.lines.slice(0, remaining)
    hiddenLines += block.lines.length - lines.length
    remaining -= lines.length
    kept.push(lines.length === block.lines.length ? block : { ...block, lines })
  }
  return { blocks: kept, hiddenLines }
}

/** Sizes a reader can compare at a glance, not exact byte counts. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`
  return `${(kilobytes / 1024).toFixed(1)} MB`
}
