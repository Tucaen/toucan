import { Bot, Sparkles, SquareTerminal, type LucideProps } from 'lucide-react'
import type { TerminalKind } from '../../shared/terminal'

/**
 * One visual identity for session kinds everywhere they appear: canvas menus, sidebars,
 * worktree actions, dormant states, and conversation history.
 */
export default function SessionKindIcon({ kind, ...props }: LucideProps & { kind: TerminalKind }): JSX.Element {
  const Icon = kind === 'terminal' ? SquareTerminal : kind === 'claude' ? Sparkles : Bot
  return <Icon aria-hidden="true" {...props} />
}
