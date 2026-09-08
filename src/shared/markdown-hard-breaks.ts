/*
 * Markdown treats a single newline as a space, so a composed message with one thought per line
 * arrives in the transcript as one reflowed paragraph - the shape the person typed is gone. Only
 * user-authored text needs this: an agent writes real markdown and means the collapse.
 *
 * Written as a remark plugin over mdast (no imports, so `shared` stays dependency-free) rather
 * than `white-space: pre-wrap`, which would also expose the indentation and blank-line padding
 * that markdown deliberately eats.
 */
type MdastNode = { type: string; value?: string; children?: MdastNode[] }

/** Splits every `text` node on newlines, joining the pieces with hard-break nodes. */
function hardBreakNewlines(node: MdastNode): void {
  if (!node.children) return
  node.children = node.children.flatMap((child) => {
    if (child.type !== 'text') {
      // `code` and `inlineCode` keep their source in `value`, not in child text nodes, so a fence
      // is never reached here and its newlines stay literal.
      hardBreakNewlines(child)
      return [child]
    }
    const lines = child.value?.split('\n') ?? []
    if (lines.length < 2) return [child]
    return lines.flatMap<MdastNode>((line, index) =>
      index === 0 ? [{ type: 'text', value: line }] : [{ type: 'break' }, { type: 'text', value: line }]
    )
  })
}

/** remark plugin: renders the newlines a person typed as line breaks instead of spaces. */
export function remarkHardBreaks(): (tree: MdastNode) => void {
  return hardBreakNewlines
}
