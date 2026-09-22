import type { RemoteChatSummary } from '../../src/shared/remote-access'

/**
 * The CL/CX provider badge on a chat row and a chat header. The two-letter glyph is the visual;
 * the provider's full name is the accessible one (#231), stated once here rather than as a pair
 * of ternaries at every call site.
 */
export default function ChatKindBadge({ kind }: { kind: RemoteChatSummary['kind'] }): JSX.Element {
  return (
    <span className="chat-kind" data-kind={kind} aria-label={kind === 'claude' ? 'Claude' : 'Codex'}>
      {kind === 'claude' ? 'CL' : 'CX'}
    </span>
  )
}
