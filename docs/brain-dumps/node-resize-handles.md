---
title: Node resize handles
created: 2026-08-30
updated: 2026-09-01
---

# Node resize handles

Canvas nodes need resize affordances that are easy to acquire from every expected edge, without requiring unusually precise pointer placement.

## Current understanding

- The existing resize handles are too difficult to hit.
- Handles appear to be available at the corners and along the top, but are missing or ineffective along the sides and bottom.
- The hit targets should make resizing from the sides and bottom as discoverable and reliable as resizing from the currently usable areas.

## Resolved (2026-09-01)

- Cause: xyflow anchors its resize controls on the node's *outer* border (`left`/`top: 100%`), while every node root (`.terminal-node`, `.chat-node`, `.worktree-node`) sets `overflow: hidden` for its rounded corners. The right line, the bottom line and three of the four corner handles were clipped away; the surviving ones were painted over by node content, leaving only a ~6px band outside the border.
- Fix: `NodeBorderResizer` now places all eight controls explicitly, just inside the border, above node content, with a grab band that grows inward (8px for edges, 9px around the corner handles) - inward is where nothing can clip it. 8px stays within the padding of every node body, so the band never covers real content.
- The offsets live inline in the component rather than in `styles.css` because xyflow's positioning rules are class-chained and win on specificity.
