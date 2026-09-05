import { useContext } from 'react'
import type { JSX } from 'react'
import type { AgentActivity } from '../../shared/agent'
import {
  byteLength,
  clampFileOperationBlocks,
  fileOperationBlocks,
  fileOperationFor,
  fileOperationLabel,
  formatByteSize,
  shortenFilePath,
  type FileOperation,
  type FileOperationBlock
} from './file-operation'
import { OpenFileContext } from './open-file-context'
import { WorkspaceRootsContext } from './workspace-root'
import { highlightedCodeLines } from './syntax-highlight'

/** What the summary adds after the path: only what the path itself cannot already say. */
function summaryDetail(operation: FileOperation): string | undefined {
  if ((operation.diffs?.length ?? 0) > 1) return `${operation.diffs!.length} files`
  if (operation.kind === 'multi-edit') {
    const count = operation.edits?.length ?? 0
    return count > 0 ? `${count} edits` : undefined
  }
  if (operation.kind === 'write' && operation.content !== undefined) {
    return formatByteSize(byteLength(operation.content))
  }
  return undefined
}

/**
 * The header line: the path first, shortened against the working directory, so a rail of cards
 * is scannable by path alone without expanding anything.
 */
export function FileOperationSummary({ operation }: { operation: FileOperation }): JSX.Element {
  const roots = useContext(WorkspaceRootsContext)
  const detail = summaryDetail(operation)
  return (
    <span className="file-op-summary">
      <span className="file-op-summary-path" title={operation.path}>
        {fileOperationLabel(operation, roots)}
      </span>
      {detail && <span className="file-op-summary-detail">{detail}</span>}
    </span>
  )
}

/**
 * The path row every file card opens with. The path is a header button's child in the summary,
 * so the actions that need a click of their own live here, in the body: copying the absolute
 * path always works, revealing it in the OS file manager is offered when the host exposes it, and
 * opening it as a file node beside this chat is offered when a canvas is behind the card.
 */
function FilePathActions({ path }: { path: string }): JSX.Element {
  const roots = useContext(WorkspaceRootsContext)
  const openFile = useContext(OpenFileContext)
  const reveal = window.terminalApi?.showItemInFolder
  return (
    <div className="file-op-path">
      <code title={path}>{shortenFilePath(path, roots)}</code>
      {openFile && (
        <button type="button" title="Open this file as a node on the canvas" onClick={() => openFile(path)}>
          Open
        </button>
      )}
      <button type="button" onClick={() => window.terminalApi?.copyText(path)}>
        Copy path
      </button>
      {reveal && (
        <button type="button" onClick={() => void reveal(path)}>
          Reveal
        </button>
      )}
    </div>
  )
}

function FileOperationBlockView({ block, showPath }: { block: FileOperationBlock; showPath: boolean }): JSX.Element {
  const highlighted = highlightedCodeLines(
    block.lines.map((line) => line.text),
    block.languagePath ?? ''
  )
  return (
    <div className={`file-op-block${block.path ? ' file-op-hunk' : ''}`}>
      {showPath && block.path && <FilePathActions path={block.path} />}
      {block.label && <small className="file-op-block-label">{block.label}</small>}
      <div className="file-op-lines">
        {block.lines.map((line, index) => (
          <div className="file-op-line" data-tone={line.tone} key={index}>
            {block.path ? (
              <>
                <span className="file-op-line-number" aria-hidden="true">
                  {line.oldNumber ?? ''}
                </span>
                <span className="file-op-line-number" aria-hidden="true">
                  {line.newNumber ?? ''}
                </span>
                <span className="file-op-line-mark" aria-hidden="true">
                  {line.tone === 'old' ? '-' : line.tone === 'new' ? '+' : ' '}
                </span>
              </>
            ) : (
              <span className="file-op-line-number" aria-hidden="true">
                {line.tone === 'old' ? '-' : line.tone === 'new' ? '+' : line.number}
              </span>
            )}
            <span className="file-op-line-text">
              <code className="hljs">{highlighted[index]}</code>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function FileOperationBody({
  operation,
  blocks
}: {
  operation: FileOperation
  blocks: FileOperationBlock[]
}): JSX.Element {
  return (
    <div className="file-op">
      {!operation.diffs?.length && <FilePathActions path={operation.path} />}
      {blocks.map((block, index) => (
        <FileOperationBlockView
          block={block}
          key={index}
          showPath={Boolean(block.path && block.path !== blocks[index - 1]?.path)}
        />
      ))}
    </div>
  )
}

/**
 * Everything a file card's body renders, computed once so the shell's family hooks stay thin.
 * Returns `null` for an activity that is not a recognizable file operation.
 */
export function fileOperationCard(
  activity: AgentActivity,
  lineBudget: number | null
): { operation: FileOperation; blocks: FileOperationBlock[]; hiddenLines: number } | null {
  const operation = fileOperationFor(activity)
  if (!operation) return null
  const clamped = clampFileOperationBlocks(fileOperationBlocks(operation, activity.content), lineBudget)
  return { operation, blocks: clamped.blocks, hiddenLines: clamped.hiddenLines }
}
