import { SquareTerminal, type LucideProps } from 'lucide-react'
import type { TerminalKind } from '../../shared/terminal'
import { ClaudeIcon, CodexIcon } from './BrandGlyphs'

/**
 * The provider (or terminal) mark for a session kind, used wherever one appears: canvas menus,
 * sidebars, worktree actions, dormant states, and conversation history. It names the provider
 * only; a role is shown beside it (an orchestrator's Network badge), never in place of it.
 */
export default function SessionKindIcon({ kind, ...props }: LucideProps & { kind: TerminalKind }): JSX.Element {
  const Icon = kind === 'terminal' ? SquareTerminal : kind === 'claude' ? ClaudeIcon : CodexIcon
  return <Icon aria-hidden="true" {...props} />
}
