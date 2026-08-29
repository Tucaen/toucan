import type { AgentActivity } from '../../shared/agent'
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
  cell?: string
  editMode?: string
}

export interface FileOperationLine {
  /** The file line this text sits on, where the operation knows it. */
  number?: number
  text: string
  tone?: 'old' | 'new'
}

/** One labelled run of lines - a read excerpt, a write preview, or one edit's before/after. */
export interface FileOperationBlock {
  label?: string
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
 */
export function parseFileOperation(activity: AgentActivity): FileOperation | null {
  const input = asRecord(activity.rawInput) ?? {}
  const name = normalizeToolName(activity.toolName)
  const notebookPath = asText(input.notebook_path) ?? asText(input.notebookPath)
  const path = asText(input.file_path)
    ?? asText(input.filePath)
    ?? notebookPath
    ?? (name || activity.kind === 'read' || activity.kind === 'edit' ? activity.locations?.[0] : undefined)
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
  const content = asText(input.content)
  const range = readRange(input)

  if (name === 'read') return { kind: 'read', path, ...(range ? { range } : {}) }
  if (name === 'write') return { kind: 'write', path, ...(content !== undefined ? { content } : {}) }
  if (name === 'multiedit') return { kind: 'multi-edit', path, edits: edits ?? [] }
  if (name === 'edit') return { kind: 'edit', path, ...(edits ? { edits } : {}) }

  // No usable name: the arguments say what happened, and failing those, ACP's kind does. A
  // payload is checked before any before/after, because adapters describe a Write as a diff
  // against nothing - reading that as an edit would dump the whole new file as added lines.
  if (content !== undefined) return { kind: 'write', path, content }
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
  const haystack = normalized.toLowerCase()
  let shortest: string | undefined
  for (const root of roots) {
    const prefix = root?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    if (!prefix) continue
    if (!haystack.startsWith(`${prefix}/`)) continue
    const relative = normalized.slice(prefix.length + 1)
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

/**
 * The body of a file card, as data: a read is its excerpt with line numbers, a write is a size
 * and a preview rather than the whole payload, and an edit is a compact before/after per edit.
 * Kept separate from the JSX so what a card shows is testable without a DOM.
 */
export function fileOperationBlocks(
  operation: FileOperation,
  content: string | undefined
): FileOperationBlock[] {
  switch (operation.kind) {
    case 'read': {
      if (!content) return []
      return [{ lines: readExcerptLines(content, operation.range?.start ?? 1) }]
    }
    case 'write':
    case 'notebook-edit': {
      const payload = operation.content
      if (payload === undefined) return content ? [{ lines: previewLines(content) }] : []
      const lines = previewLines(payload)
      const size = `${formatByteSize(byteLength(payload))} · ${lines.length} lines`
      const label = operation.kind === 'notebook-edit'
        ? `${notebookCellLabel(operation)} · ${size}`
        : size
      return [{ label, lines }]
    }
    case 'edit':
    case 'multi-edit': {
      const edits = operation.edits ?? []
      if (edits.length === 0) return content ? [{ lines: previewLines(content) }] : []
      return edits.map((edit, index) => ({
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

const FILE_OPERATION_ICONS: Record<FileOperationKind, string> = {
  read: '[]',
  write: '+',
  edit: '~',
  'multi-edit': '~',
  'notebook-edit': 'nb'
}

export function fileOperationIcon(operation: FileOperation): string {
  return FILE_OPERATION_ICONS[operation.kind]
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
