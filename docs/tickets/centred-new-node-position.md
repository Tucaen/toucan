---
title: A new node with no pointer behind it opens centred in the visible canvas
status: done
created: 2026-09-08
updated: 2026-09-08
---

## Problem

A node created by shortcut (Ctrl+T/N/P/D/H, Ctrl+Shift+N/G), by a phone spawn, or by reopening a
brain-dump capture landed with roughly half of itself off screen. Two separate errors, both in
`viewportCentreDropPosition`:

1. The flow point at the viewport centre was passed as the node's `position`, which React Flow
   reads as its **top-left corner**. A 750x660 session node therefore hung down and to the right
   of the centre, so only its top-left quarter was near the middle of the canvas.
2. The centre was measured from `window.innerWidth/innerHeight` - the whole window, including the
   sidebar, the header and the docked brain-dump / ticket-board panels. Even a corrected centre
   would have been off by half of whatever chrome was showing.

## Decisions

- Centring is a pure function, `centredNodePosition(region, size)` in `canvas-workspace.ts`: the
  corner that leaves the node's middle at the region's middle.
- The region is `visibleCanvasRegion()` - the same canvas rect in flow coordinates that snap and
  tile already use - not the window. The window is kept only as a stand-in for the case where the
  region has not laid out yet, so the helper stays total.
- The cascade is kept. Centring alone would stack a run of spawns on the exact same coordinates,
  which is the problem `cascadedNodePosition` exists to solve; the second node is then slightly
  down-right of centre.
- The pointer path is untouched. A right-click puts the node's corner at the pointer, which is the
  conventional "starts here" behaviour for a context menu; centring on the cursor would read as
  the node jumping away from the click.
- A node larger than the region (a diff node on a zoomed-in canvas) keeps its corner at the
  region's corner rather than centring, so its header - title, drag handle, close button - stays
  reachable.
- Sizes come from one table, `NEW_NODE_SIZE`, keyed by create action, because the caller choosing
  the position has the action and not yet a node. The session node's `750x660` became the named
  `NEW_SESSION_NODE_SIZE`; it is distinct from `DEFAULT_TERMINAL_SIZE`, which is only the fallback
  for restoring a node whose measurement was never persisted.

## Acceptance

- [x] A node created by shortcut is centred in the visible canvas, not hanging off its centre
- [x] The centre is measured from the canvas region, so the sidebar and docked panels do not skew it
- [x] Every create action has a size, enforced by a test over the shortcut table
- [x] A run of shortcut spawns still cascades clear rather than stacking
- [x] Right-click creation still places the node's corner at the pointer
- [x] A node too large for the region keeps its top-left corner inside it
- [x] Phone spawns and reopened brain-dump captures use the same centred drop, not the old window centre
- [x] Centring is pure and unit tested
