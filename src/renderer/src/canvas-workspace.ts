import type { Node } from '@xyflow/react'
import type { AttentionAction, AttentionKind } from '../../shared/attention'
import type { AgentTurnOutcome } from '../../shared/agent'
import type { TerminalLiveness, TerminalKind, TerminalNodeStatus } from '../../shared/terminal'
import type {
  AgentPermissionModes,
  CanvasNodeStateField,
  ConversationLineage,
  WorkspaceState,
  WorkspaceTerminalNode
} from '../../shared/workspace'
import { nodeFocusMode, RECENTLY_CLOSED_SESSION_LIMIT, type WorkspaceProject } from '../../shared/workspace'
import { defaultFileViewMode, type FileViewMode, type WorkspaceFileNode } from '../../shared/file-view'
import type { WorkspaceDiffNode } from '../../shared/git-diff'
import type { WorkspaceWorktree } from '../../shared/worktree'
import { normalizeWorktreePath } from '../../shared/worktree'
import type { WorktreeHandoffPlan } from '../../shared/worktree-handoff'
import type { ConversationTitleSource } from '../../shared/conversation-title'
import type { TicketActivityReport } from './ticket-activity'
import type { NodeGeometry } from './node-snap'
import { launchModeOnOpen, type SessionLaunchMode } from './session-launch-mode'
import { markOverdueScheduledMessages, type ScheduledMessage } from '../../shared/scheduled-message'

/** Re-exported so canvas modules keep one import site; the union itself is a shared contract. */
export type { TerminalNodeStatus }

/** What a node reports about its own attention; the reducer that consumes it lives in shared/attention.ts. */
export type NodeAttentionAction = AttentionAction

export interface TerminalNodeCallbacks {
  onStatusChange(nodeId: string, status: TerminalNodeStatus): void
  /**
   * The single channel every surface uses to report or clear attention. Optional so a node can
   * be rendered in isolation (tests, storybook-style harnesses) without a workspace behind it.
   */
  onAttention?(action: NodeAttentionAction): void
  /**
   * Which ticket files this session has been writing, so the board can show a live card. The node
   * reports paths rather than tickets because it knows its transcript but not where its project
   * keeps tickets; the workspace resolves them (`ticket-activity.ts`). Optional for the same
   * reason `onAttention` is: a node must render without a workspace behind it.
   */
  onTicketActivity?(nodeId: string, report: TicketActivityReport): void
  onConversationId(nodeId: string, conversationId: string): void
  onTitleChange(nodeId: string, title: string, source: ConversationTitleSource): Promise<boolean>
  onFocusModeChange(nodeId: string, enabled: boolean): void
  /** Persists unsent composer text so a draft outlives resize, collapse, and a workspace reload. */
  onDraftChange(nodeId: string, draft: string): void
  /**
   * Persists the node's scheduled messages. Optional so a node renders in isolation; without it
   * the composer offers no scheduling, since nothing would keep what it scheduled.
   */
  onScheduledMessagesChange?(nodeId: string, messages: ScheduledMessage[]): void
  onPermissionModeChange(provider: keyof AgentPermissionModes, modeId: string): void
  onModelChange(nodeId: string, modelId: string): void
  /** Persists terminal turn outcomes that provider-owned transcript replay cannot reproduce. */
  onTurnOutcome?(nodeId: string, outcome: AgentTurnOutcome): void
  onResume(nodeId: string): void
  onTerminalLiveness?(nodeId: string, liveness: TerminalLiveness): void
  /**
   * Whether this node's just-created session carries the terminal-context read tool - the
   * launch-time truth off `AgentCreateResult`, which is what the workspace's adoption rule
   * compares the live edge set against (`terminal-context-edges.ts`).
   */
  onTerminalContext?(nodeId: string, carried: boolean): void
  /**
   * Whether this chat's conversation has any messages yet. An empty one was never written to disk
   * by its provider, so the adoption rule restarts it new rather than resuming it (#239).
   */
  onTranscriptPresence?(nodeId: string, present: boolean): void
  /**
   * Whether the session just created advertised `session.fork`. Reported once per successful
   * create so the Branch action can be offered on launch-time truth rather than a guess, and so
   * the answer outlives the live session it came from.
   */
  onForkSupport?(nodeId: string, supported: boolean): void
  /**
   * Branch this conversation: the workspace places a child beside it that forks the transcript.
   * It belongs up there rather than on the node because creating a canvas node is the workspace's
   * job, and because the child needs the parent's project and worktree, not just its session.
   */
  onBranch?(nodeId: string): void
  /**
   * A prompt that asked for its own worktree. The composer hands it up rather than dispatching
   * it, so the work starts in a session whose working directory is the worktree from its first
   * turn - which is the only way it can be granted as a writable root.
   */
  onWorktreeHandoff?(nodeId: string, request: WorktreeHandoffPlan): void
}

interface CanvasNodePresentation {
  /** Session-local presentation state; deliberately omitted from workspace serialization. */
  fittedToCanvas?: boolean
}

/**
 * What every canvas node carries about the project it belongs to. The four fields are
 * denormalised onto the node so a header, a badge or a path row never has to look a project up,
 * which is also why a colour change has to fan out across the canvas (`withProjectColor`).
 */
interface ProjectNodeData {
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
}

export interface TerminalNodeData
  extends Record<string, unknown>, ProjectNodeData, TerminalNodeCallbacks, CanvasNodePresentation {
  kind: TerminalKind
  sessionId: string
  terminalLiveness: TerminalLiveness
  label: string
  titleSource?: ConversationTitleSource
  /** The worktree this node is attached to, if any. Attachment is fixed for the node's life. */
  worktreeId?: string
  /** Shown on the node so it is always obvious which branch a session is editing. */
  worktreeBranch?: string
  /** A worktree this node started work in but does not run in; drawn as a link, never a cwd. */
  activeWorktreeId?: string
  activeWorktreeBranch?: string
  /**
   * Where this session actually runs: the attached worktree's directory, or the project
   * checkout when unattached. This is the only value that should ever be sent as a cwd.
   */
  workingDirectory: string
  /** True when a restored node's worktree record is gone, so it must not silently run elsewhere. */
  detachedFromWorktree?: boolean
  conversationId?: string
  focusMode: boolean
  /** Unsent composer text, restored into the composer when the node comes back. */
  draft?: string
  /** Messages waiting for their scheduled time; those that came due while away restore overdue. */
  scheduledMessages?: ScheduledMessage[]
  preferredPermissionMode?: string
  modelId?: string
  turnOutcomes?: AgentTurnOutcome[]
  dormant: boolean
  /**
   * How many attention records on this node are still unread. Pushed down from the workspace so
   * the node's own indicator, the sidebar, and the header all read the same number.
   */
  unread?: number
  /** The most blocking of those unread records, so a node's own dot can say which kind it is. */
  unreadKind?: AttentionKind
  /**
   * How the next session creation opens: fresh, loading `conversationId`, or forking the
   * conversation named by `branchedFrom`. `fork` lasts exactly until the child reports a
   * conversation id of its own, after which it rehydrates as an ordinary `resume` - the same
   * one-shot life `new` has. `session-launch-mode.ts` owns both of those transitions.
   */
  launchMode: SessionLaunchMode
  /** Which conversation this one was branched off; see conversation-lineage.ts. */
  branchedFrom?: ConversationLineage
  /**
   * Whether this node's session reported the `session.fork` capability at launch, remembered on
   * the node so the Branch action still reads it once the session goes dormant. Runtime-only:
   * unknown after a restart, which `offersBranchAction` treats as permissive.
   */
  forkSupport?: boolean
  /**
   * Bumped when a terminal-context edge is adopted mid-session (`adoptTerminalContext`): the
   * session effect restarts on it, resuming the same conversation with the read tool included.
   * Runtime-only, like the edges themselves - never persisted.
   */
  terminalContextNonce?: number
  /**
   * Bumped by the node's Resume action (`relaunchInPlace`), so an `exited` session restarts in
   * place. Runtime-only, like `terminalContextNonce`.
   */
  relaunchNonce?: number
  /**
   * Written into the shell on first start: a worktree's setup command, or one of the project's
   * saved run commands picked from its row menu. Built by `terminalRunInput`.
   */
  initialInput?: string
}

export interface WorktreeNodeCallbacks {
  onRemoveWorktree(worktreeId: string): void
  onCreateNodeInWorktree(worktreeId: string, kind: TerminalKind): void
  onRunSetupCommand(worktreeId: string): void
  /** Opens a diff node reviewing this worktree's changes against the ref it was branched from. */
  onOpenDiff(worktreeId: string): void
}

export interface WorktreeNodeData
  extends Record<string, unknown>, ProjectNodeData, WorktreeNodeCallbacks, CanvasNodePresentation {
  worktreeId: string
  unavailable?: boolean
  branch: string
  path: string
  baseRef: string
  createdAt: string
  setupCommand?: string
  /** How many canvas nodes currently run in this worktree; teardown is refused while non-zero. */
  attachedNodeCount: number
}

export interface FileNodeCallbacks {
  /** The reader switched between rendered Markdown and raw text; the choice persists with the node. */
  onViewModeChange(nodeId: string, view: FileViewMode): void
  /** Opens the workspace picker and returns the selected absolute path, or null when cancelled. */
  onRequestFilePath(nodeId: string): Promise<string | null>
  /** The reader chose another file for this existing canvas node. */
  onPathChange(nodeId: string, path: string): void
}

export interface FileNodeData
  extends Record<string, unknown>, ProjectNodeData, FileNodeCallbacks, CanvasNodePresentation {
  /** Absolute path of the file shown. Kept even when the file is gone so the layout survives. */
  path: string
  view: FileViewMode
}

export interface DiffNodeCallbacks {
  /** The reader opened another file's hunks (or none); the choice persists with the node. */
  onSelectDiffPath(nodeId: string, path: string | undefined): void
}

export interface DiffNodeData
  extends Record<string, unknown>, ProjectNodeData, DiffNodeCallbacks, CanvasNodePresentation {
  /** The worktree under review; absent for the project's primary checkout. */
  worktreeId?: string
  /** Shown as the node's identity: the worktree branch, or the project name for the primary checkout. */
  label: string
  /** The checkout directory git runs in. */
  path: string
  /** What the working tree is compared against; `HEAD` for the primary checkout. */
  baseRef: string
  selectedPath?: string
}

export type TerminalCanvasNode = Node<TerminalNodeData, 'terminalNode'>
export type WorktreeCanvasNode = Node<WorktreeNodeData, 'worktreeNode'>
export type FileCanvasNode = Node<FileNodeData, 'fileNode'>
export type DiffCanvasNode = Node<DiffNodeData, 'diffNode'>
export type CanvasNode = TerminalCanvasNode | WorktreeCanvasNode | FileCanvasNode | DiffCanvasNode
export const NODE_DRAG_HANDLE = '.node-header'

/** Every callback bag a canvas node kind may need handed to it when it is built or restored. */
export type CanvasNodeCallbacks = TerminalNodeCallbacks & WorktreeNodeCallbacks & FileNodeCallbacks & DiffNodeCallbacks

/**
 * Enough accidental closes to be useful without letting a workspace snapshot grow forever.
 * @internal exported for tests
 */
export const CLOSED_SESSION_STACK_LIMIT = RECENTLY_CLOSED_SESSION_LIMIT

/**
 * What a node of each kind is restored at when its measurement was never persisted, and - for
 * every kind but the session node - what a freshly created one is sized to.
 */
const DEFAULT_TERMINAL_SIZE = { width: 520, height: 340 }
/**
 * What a freshly created session node is sized to. Larger than `DEFAULT_TERMINAL_SIZE`, which is
 * only the fallback for restoring a node whose measurement was never persisted: a new session is
 * opened to be worked in, an unmeasured one is being reconstructed.
 */
export const NEW_SESSION_NODE_SIZE = { width: 750, height: 660 }
export const DEFAULT_WORKTREE_SIZE = { width: 360, height: 232 }
/**
 * Taller than wide: a file node is for reading a document, and prose is read downward.
 * @internal exported for tests
 */
export const DEFAULT_FILE_NODE_SIZE = { width: 480, height: 560 }
/**
 * Wide enough for a file rail beside hunks that keep their line numbers readable.
 * @internal exported for tests
 */
export const DEFAULT_DIFF_NODE_SIZE = { width: 760, height: 560 }

/** The subset of `KeyboardEvent` the canvas shortcuts read, so callers can test without a DOM. */
export interface ShortcutKey {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  /** True while a held key auto-repeats; a shortcut that creates something must fire only once. */
  repeat?: boolean
}

export function closedSessionKeyAction(event: ShortcutKey, hasClosedSession: boolean): 'reopen' | 'none' {
  return hasClosedSession &&
    event.key.toLocaleLowerCase() === 't' &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey
    ? 'reopen'
    : 'none'
}

/** One entry of the canvas context menu, reachable from the keyboard without opening the menu. */
export type CreateNodeKeyAction =
  | 'create-terminal'
  | 'create-claude'
  | 'create-codex'
  | 'create-worktree'
  | 'open-history'
  | 'open-file'
  | 'open-diff'
  | 'none'

/**
 * One way to put something on the canvas: its shortcut, the size the node it produces will be,
 * and how the context menu names it.
 *
 * Deliberately a separate table from `CANVAS_NODE_KINDS` rather than a field on it, because the
 * two are not one-to-one: three actions and the history browser all produce a session node, and
 * the worktree and file actions put a dialog between the click and the node.
 */
export interface CreateNodeAction {
  action: Exclude<CreateNodeKeyAction, 'none'>
  /** Pressed with Ctrl, and with Shift where `shift` says so. */
  key: string
  shift: boolean
  /**
   * How large the node this action produces will be, so a drop position can be worked out before
   * the node exists. It must be the same object the construction site sizes the node with, or the
   * node is centred by a number nothing else uses.
   */
  size: { width: number; height: number }
  title: string
  description: string
}

/**
 * Ctrl+P mirrors VS Code's quick-open for the file node; the others follow the same "Ctrl plus the
 * node's initial" idea, with Shift for the secondary agent and for the worktree (Ctrl+Shift+G is
 * VS Code's source-control view). Ctrl+Alt is deliberately unused: on German layouts it is AltGr
 * and types characters. Ctrl+Shift+T is taken by `closedSessionKeyAction`.
 *
 * Order is menu order: the shortcut handler, the hints and the menu itself all read this list.
 */
export const CREATE_NODE_ACTIONS = [
  {
    action: 'create-terminal',
    key: 't',
    shift: false,
    size: NEW_SESSION_NODE_SIZE,
    title: 'Terminal',
    description: 'Windows shell'
  },
  {
    action: 'create-claude',
    key: 'n',
    shift: false,
    size: NEW_SESSION_NODE_SIZE,
    title: 'Claude',
    description: 'Unified ACP chat'
  },
  {
    action: 'create-codex',
    key: 'n',
    shift: true,
    size: NEW_SESSION_NODE_SIZE,
    title: 'Codex',
    description: 'Unified ACP chat'
  },
  {
    action: 'create-worktree',
    key: 'g',
    shift: true,
    size: DEFAULT_WORKTREE_SIZE,
    title: 'Worktree',
    description: 'Isolated branch for parallel work'
  },
  {
    action: 'open-history',
    key: 'h',
    shift: false,
    size: NEW_SESSION_NODE_SIZE,
    title: 'History',
    description: 'Resume a past conversation'
  },
  {
    action: 'open-file',
    key: 'p',
    shift: false,
    size: DEFAULT_FILE_NODE_SIZE,
    title: 'File…',
    description: 'Read a project file on the canvas'
  },
  {
    action: 'open-diff',
    key: 'd',
    shift: false,
    size: DEFAULT_DIFF_NODE_SIZE,
    title: 'Diff',
    description: "Review the checkout's changes against HEAD"
  }
] satisfies readonly CreateNodeAction[]

/**
 * Compile-time proof that every action has a row. An action missing one would have no shortcut, no
 * menu entry and an `undefined` drop size, so it must not be possible to add one to the union and
 * forget the table - which the derived records below cannot catch, being keyed maps.
 */
type UnlistedCreateAction = Exclude<
  Exclude<CreateNodeKeyAction, 'none'>,
  (typeof CREATE_NODE_ACTIONS)[number]['action']
>
const _CREATE_NODE_ACTIONS_ARE_EXHAUSTIVE: [UnlistedCreateAction] extends [never] ? true : false = true

/** Shown beside each menu entry so the shortcuts are discoverable where the mouse already is. */
export const NODE_SHORTCUT_LABELS = Object.fromEntries(
  CREATE_NODE_ACTIONS.map(({ action, key, shift }) => [
    action,
    `Ctrl+${shift ? 'Shift+' : ''}${key.toLocaleUpperCase()}`
  ])
) as Record<Exclude<CreateNodeKeyAction, 'none'>, string>

/** The size each action's node is built at, keyed for the caller placing it. */
export const NEW_NODE_SIZE = Object.fromEntries(
  CREATE_NODE_ACTIONS.map(({ action, size }) => [action, size])
) as Record<Exclude<CreateNodeKeyAction, 'none'>, { width: number; height: number }>

export interface CreateNodeKeyContext {
  /** Whether the key went to a terminal, where Ctrl+P/N/H/T are readline keys the shell must keep. */
  editingTerminal: boolean
}

/**
 * Text fields are fine - none of these keys mean anything in an input - but a terminal owns them,
 * so the shortcut yields there. A held key repeats the event and would otherwise spawn a node per
 * repeat, so only the first press counts.
 */
export function createNodeKeyAction(event: ShortcutKey, context: CreateNodeKeyContext): CreateNodeKeyAction {
  if (context.editingTerminal || event.repeat || !event.ctrlKey || event.altKey || event.metaKey) return 'none'
  const key = event.key.toLocaleLowerCase()
  return (
    CREATE_NODE_ACTIONS.find((binding) => binding.key === key && binding.shift === event.shiftKey)?.action ?? 'none'
  )
}

export function isTerminalCanvasNode(node: CanvasNode): node is TerminalCanvasNode {
  return node.type === 'terminalNode'
}

/** A session node whose surface is the AI-chat transcript rather than an xterm terminal. */
export function isChatCanvasNode(node: CanvasNode): node is TerminalCanvasNode {
  return isTerminalCanvasNode(node) && node.data.kind !== 'terminal'
}

export function isWorktreeCanvasNode(node: CanvasNode): node is WorktreeCanvasNode {
  return node.type === 'worktreeNode'
}

export function isFileCanvasNode(node: CanvasNode): node is FileCanvasNode {
  return node.type === 'fileNode'
}

export function isDiffCanvasNode(node: CanvasNode): node is DiffCanvasNode {
  return node.type === 'diffNode'
}

/**
 * Nodes that are layout rather than sessions: closing one is not an accidental close worth
 * undoing, so they never enter the recently-closed stack - and never wipe it either. That rule is
 * enforced in exactly one place, `rememberClosedSessionNodes`; a caller must never pre-filter
 * removed nodes on its own, or the two halves can disagree about what a close means.
 * @internal exported for tests
 */
export function isLayoutCanvasNode(node: CanvasNode): node is FileCanvasNode | DiffCanvasNode {
  return isFileCanvasNode(node) || isDiffCanvasNode(node)
}

/**
 * What a session node's status is. A node that has not reported one yet is read from the node
 * itself - dormant means saved, anything else is starting - so the workspace, the sidebar, the
 * worktree adoption gate and a just-reopened node cannot each pick a different default.
 */
export function sessionNodeStatus(
  node: { id: string; data: { dormant: boolean } },
  statuses: Readonly<Record<string, TerminalNodeStatus>> = {}
): TerminalNodeStatus {
  return statuses[node.id] ?? (node.data.dormant ? 'dormant' : 'starting')
}

/**
 * A project's colour is denormalised onto every node it owns at node creation, so changing it has
 * to fan out across the canvas in the same update - otherwise the sidebar and the header chip
 * retint immediately while the nodes keep the old colour until the next restore.
 *
 * Every kind carries `projectColor`, so this is one patch. The cast is what that costs:
 * TypeScript keeps a union's discriminant only when each member is rebuilt separately, and doing
 * that here would be one identical branch per kind.
 */
export function withProjectColor(nodes: CanvasNode[], projectId: string, projectColor: string): CanvasNode[] {
  let changed = false
  const next = nodes.map((node) => {
    if (node.data.projectId !== projectId || node.data.projectColor === projectColor) return node
    changed = true
    return { ...node, data: { ...node.data, projectColor } } as CanvasNode
  })
  return changed ? next : nodes
}

export interface RestoredCanvasWorkspace {
  nodes: CanvasNode[]
  statuses: Record<string, TerminalNodeStatus>
  nextSessionNumber: number
  activeProjectId: string
}

/** How far each retry of `cascadedNodePosition` steps, and how many times it may step. */
const CASCADE_STEP = 48
const CASCADE_ATTEMPTS = 24

/**
 * A spot near `origin` whose top-left corner no node already sits on, cascaded down-right.
 *
 * A node created from the canvas lands where the pointer was, which is inherently distinguishable.
 * One created with no pointer behind it - a phone spawning a chat - has only a default spot, and
 * two of those in a row would land on the exact same coordinates, hiding the first behind the
 * second completely. This is the same cascade a window manager offers for the same reason, and it
 * makes the same promise: the new node's header and controls are reachable, *not* that it does not
 * overlap (a session node is many times wider than one step). After enough attempts the last
 * candidate is taken regardless - a node landing on another is a far smaller problem than a search
 * that does not end.
 */
export function cascadedNodePosition(
  nodes: readonly { position: { x: number; y: number } }[],
  origin: { x: number; y: number }
): { x: number; y: number } {
  const taken = (candidate: { x: number; y: number }): boolean =>
    nodes.some(
      (node) =>
        Math.abs(node.position.x - candidate.x) < CASCADE_STEP && Math.abs(node.position.y - candidate.y) < CASCADE_STEP
    )
  let candidate = origin
  for (let attempt = 0; attempt < CASCADE_ATTEMPTS && taken(candidate); attempt += 1) {
    candidate = {
      x: origin.x + (attempt + 1) * CASCADE_STEP,
      y: origin.y + (attempt + 1) * CASCADE_STEP
    }
  }
  return candidate
}

/**
 * The top-left corner that leaves a node of `size` in the middle of `region`, both in flow
 * coordinates. React Flow positions a node by its corner, so a node handed the centre of the
 * region hangs down and to the right of it with half of itself off screen; centring means
 * offsetting by half the node.
 *
 * A node larger than the region keeps its corner at the region's corner, overhanging right and
 * bottom only. Centring it would push its header out of sight, and the header is where the title, the
 * drag handle and the close button are.
 */
export function centredNodePosition(
  region: NodeGeometry,
  size: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: region.position.x + Math.max(0, (region.width - size.width) / 2),
    y: region.position.y + Math.max(0, (region.height - size.height) / 2)
  }
}

type SessionRestoreWorkspace = Pick<WorkspaceState, 'projects' | 'worktrees' | 'agentPermissionModes'>
type SessionRestoreMode = 'hydrate' | 'reopen'

/**
 * What a kind's restore may read about the workspace a record is coming back into, beyond its own
 * project. Worktrees are reached through the lookup rather than as a list, because the only
 * worktrees a record may resolve are the ones that survived their own pruning.
 */
export interface CanvasRestoreContext {
  worktreeById(worktreeId: string): WorkspaceWorktree | undefined
  attachedNodeCount(worktreeId: string): number
  agentPermissionModes?: AgentPermissionModes
}

function canvasRestoreContext(
  worktrees: readonly WorkspaceWorktree[],
  attachedNodeCount: (worktreeId: string) => number,
  agentPermissionModes?: AgentPermissionModes
): CanvasRestoreContext {
  const byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  return {
    worktreeById: (worktreeId) => byId.get(worktreeId),
    attachedNodeCount,
    agentPermissionModes
  }
}

/**
 * The persisted size of a node: what it measures on screen, else what its style carries, else the
 * `fallback` its own serializer names. A node with no measurement is being reconstructed, not
 * opened, which is why the fallback is a restore size rather than the size a new node opens at.
 */
function measured(node: CanvasNode, fallback: { width: number; height: number }): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : fallback.width
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : fallback.height
  return {
    width: node.measured?.width ?? styleWidth,
    height: node.measured?.height ?? styleHeight
  }
}

/** @internal exported for tests */
export function serializeCanvasNode(node: TerminalCanvasNode): WorkspaceTerminalNode {
  const size = measured(node, DEFAULT_TERMINAL_SIZE)
  return {
    id: node.id,
    ...(node.data.kind === 'terminal' ? { sessionId: node.data.sessionId } : {}),
    kind: node.data.kind,
    label: node.data.label,
    ...(node.data.titleSource ? { titleSource: node.data.titleSource } : {}),
    projectId: node.data.projectId,
    ...(node.data.worktreeId ? { worktreeId: node.data.worktreeId } : {}),
    ...(node.data.activeWorktreeId ? { activeWorktreeId: node.data.activeWorktreeId } : {}),
    position: node.position,
    width: size.width,
    height: size.height,
    ...(node.data.conversationId ? { conversationId: node.data.conversationId } : {}),
    ...(node.data.modelId ? { modelId: node.data.modelId } : {}),
    ...(node.data.turnOutcomes?.length ? { turnOutcomes: node.data.turnOutcomes } : {}),
    ...(node.data.draft ? { draft: node.data.draft } : {}),
    ...(node.data.scheduledMessages?.length ? { scheduledMessages: node.data.scheduledMessages } : {}),
    ...(node.data.branchedFrom ? { branchedFrom: node.data.branchedFrom } : {}),
    ...(node.data.kind === 'terminal' ? {} : { focusMode: node.data.focusMode }),
    ...(node.data.kind === 'terminal' ? { terminalLiveness: node.data.terminalLiveness } : {})
  }
}

/**
 * Store only durable session data; React callbacks are rebuilt when the node is reopened.
 *
 * This is the *one* enforcement site of "a layout node is not a session": a closed file or diff
 * node is neither a reopen target nor a reason to wipe the stack, while closing a worktree node
 * (or a chat that cannot be resumed) still clears it, because what comes back could otherwise be
 * pointing at a checkout that has gone. Callers hand over everything that was removed.
 */
export function rememberClosedSessionNodes(
  current: WorkspaceTerminalNode[],
  removedNodes: CanvasNode[]
): WorkspaceTerminalNode[] {
  if (removedNodes.length === 0) return current
  const closable = removedNodes.filter((node) => !isLayoutCanvasNode(node))
  if (closable.length === 0) return current
  const sessionNodes = closable.filter(isTerminalCanvasNode)
  if (
    sessionNodes.length !== closable.length ||
    sessionNodes.some((node) => node.data.kind !== 'terminal' && !node.data.conversationId)
  )
    return []
  const closed = sessionNodes.map(serializeCanvasNode)
  return [...current, ...closed].slice(-CLOSED_SESSION_STACK_LIMIT)
}

function restoreTerminalCanvasNode(
  savedNode: WorkspaceTerminalNode,
  project: WorkspaceProject,
  context: CanvasRestoreContext,
  callbacks: TerminalNodeCallbacks,
  mode: SessionRestoreMode
): TerminalCanvasNode {
  const recordedWorktree = savedNode.worktreeId ? context.worktreeById(savedNode.worktreeId) : undefined
  const worktree = recordedWorktree?.unavailable ? undefined : recordedWorktree
  // A node whose worktree record vanished must never quietly fall back to the project
  // checkout and start writing there, so it restores detached and dormant instead.
  const detachedFromWorktree = Boolean(savedNode.worktreeId) && !worktree
  // Workspace hydration leaves real terminal processes dormant; an explicit undo opens the
  // process immediately, just as creating or resuming a node does.
  const dormant = detachedFromWorktree || (mode === 'hydrate' && savedNode.kind === 'terminal')
  const terminalLiveness: TerminalLiveness =
    savedNode.kind === 'terminal' ? (savedNode.terminalLiveness === 'exited' ? 'exited' : 'unverifiable') : 'live'
  return {
    id: savedNode.id,
    type: 'terminalNode',
    dragHandle: NODE_DRAG_HANDLE,
    ...(mode === 'reopen' ? { selected: true } : {}),
    position: savedNode.position,
    data: {
      kind: savedNode.kind,
      sessionId: savedNode.sessionId ?? savedNode.id,
      terminalLiveness,
      label: savedNode.label,
      titleSource: savedNode.titleSource,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectColor: project.color,
      worktreeId: worktree?.id,
      worktreeBranch: worktree?.branch,
      activeWorktreeId: savedNode.activeWorktreeId,
      activeWorktreeBranch: savedNode.activeWorktreeId
        ? context.worktreeById(savedNode.activeWorktreeId)?.branch
        : undefined,
      workingDirectory: worktree?.path ?? project.path,
      detachedFromWorktree,
      conversationId: savedNode.conversationId,
      focusMode: nodeFocusMode(savedNode),
      draft: savedNode.draft,
      // A node is only ever restored after being off the canvas - Toucan closed, or the node
      // closed - and nothing was there to deliver its messages meanwhile, so any that came due
      // wait for an explicit Send now rather than going out unannounced.
      scheduledMessages: markOverdueScheduledMessages(savedNode.scheduledMessages, Date.now()),
      preferredPermissionMode:
        savedNode.kind === 'terminal' ? undefined : context.agentPermissionModes?.[savedNode.kind],
      modelId: savedNode.kind === 'terminal' ? undefined : savedNode.modelId,
      turnOutcomes: savedNode.kind === 'terminal' ? undefined : savedNode.turnOutcomes,
      dormant,
      branchedFrom: savedNode.branchedFrom,
      launchMode: launchModeOnOpen(savedNode),
      onStatusChange: callbacks.onStatusChange,
      onAttention: callbacks.onAttention,
      onTicketActivity: callbacks.onTicketActivity,
      onConversationId: callbacks.onConversationId,
      onTitleChange: callbacks.onTitleChange,
      onFocusModeChange: callbacks.onFocusModeChange,
      onDraftChange: callbacks.onDraftChange,
      onScheduledMessagesChange: callbacks.onScheduledMessagesChange,
      onPermissionModeChange: callbacks.onPermissionModeChange,
      onModelChange: callbacks.onModelChange,
      onTurnOutcome: callbacks.onTurnOutcome,
      onResume: callbacks.onResume,
      onTerminalLiveness: callbacks.onTerminalLiveness,
      onTerminalContext: callbacks.onTerminalContext,
      onTranscriptPresence: callbacks.onTranscriptPresence,
      onForkSupport: callbacks.onForkSupport,
      onBranch: callbacks.onBranch,
      onWorktreeHandoff: callbacks.onWorktreeHandoff
    },
    style: { width: savedNode.width, height: savedNode.height }
  }
}

export function reopenClosedSession(
  recentlyClosedNodes: WorkspaceTerminalNode[],
  workspace: SessionRestoreWorkspace,
  callbacks: TerminalNodeCallbacks
): { node: TerminalCanvasNode | null; recentlyClosedNodes: WorkspaceTerminalNode[] } {
  const remaining = [...recentlyClosedNodes]
  // Nothing is attached yet at the moment a node is reopened, and the count a worktree node shows
  // is recomputed from the canvas straight afterwards (`applyAttachedNodeCounts`).
  const context = canvasRestoreContext(workspace.worktrees ?? [], () => 0, workspace.agentPermissionModes)
  while (remaining.length > 0) {
    const savedNode = remaining.pop()!
    if (savedNode.kind !== 'terminal' && !savedNode.conversationId) {
      return { node: null, recentlyClosedNodes: [] }
    }
    const project = workspace.projects.find((candidate) => candidate.id === savedNode.projectId)
    if (project) {
      return {
        node: restoreTerminalCanvasNode(savedNode, project, context, callbacks, 'reopen'),
        recentlyClosedNodes: remaining
      }
    }
  }
  return { node: null, recentlyClosedNodes: remaining }
}

export function serializeWorktreeNode(node: WorktreeCanvasNode): WorkspaceWorktree {
  const size = measured(node, DEFAULT_WORKTREE_SIZE)
  return {
    id: node.data.worktreeId,
    ...(node.data.unavailable ? { unavailable: true } : {}),
    projectId: node.data.projectId,
    branch: node.data.branch,
    path: node.data.path,
    baseRef: node.data.baseRef,
    createdAt: node.data.createdAt,
    position: node.position,
    width: size.width,
    height: size.height
  }
}

export interface WorktreeNodeSeed {
  unavailable?: boolean
  /** The workspace's own id for the worktree; the canvas node's id is derived from it. */
  worktreeId: string
  branch: string
  path: string
  baseRef: string
  createdAt: string
  position: { x: number; y: number }
  width?: number
  height?: number
  /** How many nodes already run here; a worktree that was just created carries none. */
  attachedNodeCount?: number
  /** Selected when the user asked for this worktree themselves; a swept one appears quietly. */
  selected?: boolean
}

/**
 * The one place a worktree node is built, whether it was created from the dialog, handed off to by
 * a prompt that asked for its own worktree, discovered by the sweep, or restored from a snapshot.
 * Every path therefore lands with the same drag handle, size rules, denormalised project - and
 * with `deletable: false`, which is the load-bearing one.
 */
export function createWorktreeCanvasNode(
  seed: WorktreeNodeSeed,
  project: WorkspaceProject,
  callbacks: WorktreeNodeCallbacks
): WorktreeCanvasNode {
  return {
    id: `worktree:${seed.worktreeId}`,
    type: 'worktreeNode',
    dragHandle: NODE_DRAG_HANDLE,
    // Teardown is a deliberate, evidence-gated act; the Delete key must never be able to
    // drop the record and orphan a directory git still knows about.
    deletable: false,
    ...(seed.selected ? { selected: true } : {}),
    position: seed.position,
    data: {
      worktreeId: seed.worktreeId,
      ...(seed.unavailable ? { unavailable: true } : {}),
      branch: seed.branch,
      path: normalizeWorktreePath(seed.path),
      baseRef: seed.baseRef,
      createdAt: seed.createdAt,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectColor: project.color,
      setupCommand: project.setupCommand,
      attachedNodeCount: seed.attachedNodeCount ?? 0,
      onRemoveWorktree: callbacks.onRemoveWorktree,
      onCreateNodeInWorktree: callbacks.onCreateNodeInWorktree,
      onRunSetupCommand: callbacks.onRunSetupCommand,
      onOpenDiff: callbacks.onOpenDiff
    },
    style: {
      width: seed.width ?? DEFAULT_WORKTREE_SIZE.width,
      height: seed.height ?? DEFAULT_WORKTREE_SIZE.height
    }
  }
}

/** @internal exported for tests */
export function serializeFileNode(node: FileCanvasNode): WorkspaceFileNode {
  const size = measured(node, DEFAULT_FILE_NODE_SIZE)
  return {
    id: node.id,
    projectId: node.data.projectId,
    path: node.data.path,
    view: node.data.view,
    position: node.position,
    width: size.width,
    height: size.height
  }
}

/** Repoints one file node without rebuilding the canvas object that owns its layout. */
export function changeFileCanvasNodePath(nodes: CanvasNode[], nodeId: string, path: string): CanvasNode[] {
  const target = nodes.find((node) => isFileCanvasNode(node) && node.id === nodeId)
  if (!target || target.data.path === path) return nodes
  return nodes.map((node) =>
    isFileCanvasNode(node) && node.id === nodeId ? { ...node, data: { ...node.data, path } } : node
  )
}

export interface FileNodeSeed {
  id: string
  path: string
  position: { x: number; y: number }
  /** Absent for a freshly opened file, which then opens the way its type reads best. */
  view?: FileViewMode
  width?: number
  height?: number
}

/**
 * The one place a file node is built, whether it is opened from the picker, from a transcript's
 * file card, or restored from a snapshot - so every path lands with the same header, drag handle
 * and size rules. The project is denormalised onto the node exactly as it is for session nodes.
 */
export function createFileCanvasNode(
  seed: FileNodeSeed,
  project: WorkspaceProject,
  callbacks: FileNodeCallbacks
): FileCanvasNode {
  return {
    id: seed.id,
    type: 'fileNode',
    dragHandle: NODE_DRAG_HANDLE,
    position: seed.position,
    data: {
      path: seed.path,
      view: seed.view ?? defaultFileViewMode(seed.path),
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectColor: project.color,
      onViewModeChange: callbacks.onViewModeChange,
      onRequestFilePath: callbacks.onRequestFilePath,
      onPathChange: callbacks.onPathChange
    },
    style: { width: seed.width ?? DEFAULT_FILE_NODE_SIZE.width, height: seed.height ?? DEFAULT_FILE_NODE_SIZE.height }
  }
}

/** @internal exported for tests */
export function serializeDiffNode(node: DiffCanvasNode): WorkspaceDiffNode {
  const size = measured(node, DEFAULT_DIFF_NODE_SIZE)
  return {
    id: node.id,
    projectId: node.data.projectId,
    ...(node.data.worktreeId ? { worktreeId: node.data.worktreeId } : {}),
    position: node.position,
    width: size.width,
    height: size.height,
    ...(node.data.selectedPath ? { selectedPath: node.data.selectedPath } : {})
  }
}

export interface DiffNodeSeed {
  id: string
  position: { x: number; y: number }
  selectedPath?: string
  width?: number
  height?: number
}

/**
 * The one place a diff node is built, from the worktree node header, the canvas menu, or a
 * snapshot. Against a worktree it reviews that directory against the ref the branch was cut
 * from; without one it reviews the project's primary checkout against `HEAD`, which is the only
 * base a checkout with no recorded origin has.
 */
export function createDiffCanvasNode(
  seed: DiffNodeSeed,
  project: WorkspaceProject,
  worktree: Pick<WorkspaceWorktree, 'id' | 'branch' | 'path' | 'baseRef'> | undefined,
  callbacks: DiffNodeCallbacks
): DiffCanvasNode {
  return {
    id: seed.id,
    type: 'diffNode',
    dragHandle: NODE_DRAG_HANDLE,
    position: seed.position,
    data: {
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectColor: project.color,
      ...(worktree ? { worktreeId: worktree.id } : {}),
      label: worktree ? worktree.branch : project.name,
      path: worktree ? worktree.path : project.path,
      baseRef: worktree ? worktree.baseRef : 'HEAD',
      ...(seed.selectedPath ? { selectedPath: seed.selectedPath } : {}),
      onSelectDiffPath: callbacks.onSelectDiffPath
    },
    style: { width: seed.width ?? DEFAULT_DIFF_NODE_SIZE.width, height: seed.height ?? DEFAULT_DIFF_NODE_SIZE.height }
  }
}

/** Records which file a diff node has open without rebuilding the canvas object that owns its layout. */
export function selectDiffCanvasNodePath(nodes: CanvasNode[], nodeId: string, path: string | undefined): CanvasNode[] {
  const target = nodes.find((node) => isDiffCanvasNode(node) && node.id === nodeId)
  if (!target || target.data.selectedPath === path) return nodes
  return nodes.map((node) =>
    isDiffCanvasNode(node) && node.id === nodeId ? { ...node, data: { ...node.data, selectedPath: path } } : node
  )
}

/** A worktree's diff nodes go with it: they review a directory that no longer exists. */
export function withoutWorktree(nodes: CanvasNode[], worktreeId: string): CanvasNode[] {
  return nodes.filter(
    (node) =>
      !(isWorktreeCanvasNode(node) && node.data.worktreeId === worktreeId) &&
      !(isDiffCanvasNode(node) && node.data.worktreeId === worktreeId)
  )
}

/**
 * The mechanical concerns of one canvas node kind, so adding or changing a kind is one table entry
 * and one `WorkspaceState` field rather than an edit to every loop that walks the canvas.
 *
 * Deliberately only the mechanical ones: serialize (which owns the size it falls back to) and
 * restore-and-prune. A kind's behaviour - its callback bag, its status, its scrollback, what a
 * phone may see of it - stays where it already lives, because describing those here would turn
 * every entry into optional hooks one kind uses and move the branching into `if (kind.supportsX)`.
 */
export interface CanvasNodeKind<Saved extends { projectId: string }, N extends CanvasNode> {
  field: CanvasNodeStateField
  /**
   * Written to the snapshot even when empty. True only for the two fields version 3 has always
   * had; a kind added later stays absent when there is none, so a workspace that never opened one
   * keeps writing the snapshot shape it always did.
   */
  alwaysPersisted: boolean
  is(node: CanvasNode): node is N
  serialize(node: N): Saved
  /**
   * Rebuilds one saved record. Returning `null` prunes it: the record describes something the
   * workspace no longer has. A record whose *project* is gone is pruned by the caller, for every
   * kind at once, so no entry has to write that rule again.
   */
  restore(
    saved: Saved,
    project: WorkspaceProject,
    context: CanvasRestoreContext,
    callbacks: CanvasNodeCallbacks
  ): N | null
}

/**
 * One table entry with its `Saved` and node types erased, so the four can live in one list. The
 * two casts are the whole price of that erasure and are contained here: `canvasNodeKind` is only
 * ever handed a matching pair, and every caller guards `serialize` with `is`.
 */
export interface CanvasNodeKindEntry {
  field: CanvasNodeStateField
  alwaysPersisted: boolean
  is(node: CanvasNode): boolean
  serialize(node: CanvasNode): unknown
  restore(
    saved: { projectId: string },
    project: WorkspaceProject,
    context: CanvasRestoreContext,
    callbacks: CanvasNodeCallbacks
  ): CanvasNode | null
}

/** @internal exported for tests */
export function canvasNodeKind<Saved extends { projectId: string }, N extends CanvasNode>(
  kind: CanvasNodeKind<Saved, N>
): CanvasNodeKindEntry {
  return {
    field: kind.field,
    alwaysPersisted: kind.alwaysPersisted,
    is: kind.is,
    serialize: (node) => kind.serialize(node as N),
    restore: (saved, project, context, callbacks) => kind.restore(saved as Saved, project, context, callbacks)
  }
}

/**
 * Every canvas node kind, in the order they are laid on the canvas: worktrees first, so a session
 * node sits above the worktree it runs in, then sessions, then the layout kinds.
 */
export const CANVAS_NODE_KINDS: readonly CanvasNodeKindEntry[] = [
  canvasNodeKind<WorkspaceWorktree, WorktreeCanvasNode>({
    field: 'worktrees',
    alwaysPersisted: true,
    is: isWorktreeCanvasNode,
    serialize: serializeWorktreeNode,
    restore: (saved, project, context, callbacks) =>
      createWorktreeCanvasNode(
        { ...saved, worktreeId: saved.id, attachedNodeCount: context.attachedNodeCount(saved.id) },
        project,
        callbacks
      )
  }),
  canvasNodeKind<WorkspaceTerminalNode, TerminalCanvasNode>({
    field: 'nodes',
    alwaysPersisted: true,
    is: isTerminalCanvasNode,
    serialize: serializeCanvasNode,
    restore: (saved, project, context, callbacks) =>
      restoreTerminalCanvasNode(saved, project, context, callbacks, 'hydrate')
  }),
  canvasNodeKind<WorkspaceFileNode, FileCanvasNode>({
    field: 'files',
    alwaysPersisted: false,
    is: isFileCanvasNode,
    serialize: serializeFileNode,
    // A file whose project is gone has no root to be read under, so it goes with the project; a
    // file that is merely missing from disk keeps its node, which reports that itself.
    restore: (saved, project, _context, callbacks) => createFileCanvasNode(saved, project, callbacks)
  }),
  canvasNodeKind<WorkspaceDiffNode, DiffCanvasNode>({
    field: 'diffs',
    alwaysPersisted: false,
    is: isDiffCanvasNode,
    serialize: serializeDiffNode,
    // A review goes with its worktree record the way `withoutWorktree` removes it when the
    // worktree is torn down; a checkout that is merely dirty or gone from disk keeps its node.
    restore: (saved, project, context, callbacks) => {
      const worktree = saved.worktreeId ? context.worktreeById(saved.worktreeId) : undefined
      if (saved.worktreeId && !worktree) return null
      return createDiffCanvasNode(saved, project, worktree, callbacks)
    }
  })
]

/**
 * The persisted half of every canvas node, one array per kind, in one pass over the canvas.
 *
 * `beforeSave` runs first on each node, which is how a node maximised into fit mode is persisted
 * at the geometry it will return to rather than filling the canvas.
 */
export function serializeCanvasNodes(
  nodes: readonly CanvasNode[],
  beforeSave: (node: CanvasNode) => CanvasNode = (node) => node,
  kinds: readonly CanvasNodeKindEntry[] = CANVAS_NODE_KINDS
): Pick<WorkspaceState, 'nodes' | 'worktrees' | 'files' | 'diffs'> {
  // Seeded from the standard table's `alwaysPersisted` entries, so the two fields version 3 has
  // always had are written even when the canvas has none of them - and so the return type stays
  // true whichever `kinds` list is handed in. Everything else is absent until there is one.
  const snapshot: Record<string, unknown[]> = Object.fromEntries(
    CANVAS_NODE_KINDS.filter((kind) => kind.alwaysPersisted).map((kind) => [kind.field, []])
  )
  for (const kind of kinds) {
    const records = nodes.filter((node) => kind.is(node)).map((node) => kind.serialize(beforeSave(node)))
    if (records.length > 0 || kind.alwaysPersisted) snapshot[kind.field] = records
  }
  // Sound by the seeding above; the erasure is what costs the cast, not the shape.
  return snapshot as unknown as Pick<WorkspaceState, 'nodes' | 'worktrees' | 'files' | 'diffs'>
}

function savedRecords(state: WorkspaceState, field: CanvasNodeStateField): readonly { projectId: string }[] {
  return state[field] ?? []
}

export function restoreCanvasWorkspace(
  state: WorkspaceState,
  callbacks: CanvasNodeCallbacks,
  kinds: readonly CanvasNodeKindEntry[] = CANVAS_NODE_KINDS
): RestoredCanvasWorkspace {
  const projectsById = new Map(state.projects.map((project) => [project.id, project]))
  // The same "its project is gone, so it goes too" rule the loop below applies to every kind,
  // applied to the worktree records up front: the session and diff kinds resolve their worktree
  // through this set, and a record naming a deleted project must not be resolvable for them.
  const worktrees = (state.worktrees ?? []).filter((worktree) => projectsById.has(worktree.projectId))
  const worktreeIds = new Set(worktrees.map((worktree) => worktree.id))
  const attachedCounts = new Map<string, number>()
  for (const node of state.nodes) {
    if (node.worktreeId && worktreeIds.has(node.worktreeId)) {
      attachedCounts.set(node.worktreeId, (attachedCounts.get(node.worktreeId) ?? 0) + 1)
    }
  }
  const context = canvasRestoreContext(
    worktrees,
    (worktreeId) => attachedCounts.get(worktreeId) ?? 0,
    state.agentPermissionModes
  )

  const nodes = kinds.flatMap((kind) =>
    savedRecords(state, kind.field).flatMap((saved) => {
      const project = projectsById.get(saved.projectId)
      if (!project) return []
      const node = kind.restore(saved, project, context, callbacks)
      return node ? [node] : []
    })
  )

  const sessionNodes = nodes.filter(isTerminalCanvasNode)
  const highestSessionNumber = sessionNodes.reduce((highest, node) => {
    const match = node.data.label.match(/ (\d+)$/)
    return Math.max(highest, match ? Number(match[1]) : 0)
  }, 0)

  return {
    nodes,
    statuses: Object.fromEntries(sessionNodes.map((node) => [node.id, sessionNodeStatus(node)])),
    nextSessionNumber: highestSessionNumber + 1,
    activeProjectId: state.projects.some((project) => project.id === state.activeProjectId)
      ? state.activeProjectId!
      : state.projects[0].id
  }
}
