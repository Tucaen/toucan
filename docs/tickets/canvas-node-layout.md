---
title: Snap, tile and remember node layouts on the canvas
status: done
created: 2026-09-08
updated: 2026-09-08
---

## Problem

Arranging nodes is manual: to put two sessions side by side the user fits one to the canvas,
drags it down to half width, fits the second, drags that to the other half. Fit-to-canvas and the
fit-view button are the only layout aids.

## Prototype verdict

Branch `prototype/canvas-layout` (commit `a3d71e0`) put five candidates in the real app behind a
throwaway panel. Evaluated 2026-09-08:

- **Keep:** Alt+Arrow snap with Windows semantics, including pair mode (two nodes selected →
  side by side / stacked); tile cycling grid → columns → rows; match size; layout slots.
- **Drop:** Alt+Shift+Arrow edge alignment - not useful in practice.

## Decisions

- Fit-to-canvas is unified with snap: the header button and Alt+Up both maximise (snap
  full/full), Alt+Down and the button restore. One state model, one reflow on canvas resize.
- One node per slice: snapping a node into a slice another node already occupies restores that
  node first (generalises the old "at most one fitted node" rule).
- A maximised node is still never persisted filling the canvas; halves and quarters persist where
  they render, and snap state itself is session-local.
- Layout slots persist with the workspace. Restoring a slot skips nodes that no longer exist and
  leaves nodes the slot never saw alone.
- Tile mode (which layout the next press produces) is session-local.

## Keys

| Keys           | Action                                                                           |
| -------------- | -------------------------------------------------------------------------------- |
| Alt+←/→/↑/↓    | Snap selected node; with exactly two selected, place them side by side / stacked |
| Alt+Shift+S    | Selected nodes take the size of the first selected                               |
| Ctrl+Shift+A   | Tile all nodes (or the selection when 2+ selected): grid → columns → rows        |
| Alt+Shift+1..9 | Save layout slot                                                                 |
| Alt+1..9       | Restore layout slot                                                              |

Alt is used because Ctrl+letter is taken by node creation and Ctrl+Alt is AltGr on German layouts.
Text fields keep Alt+Arrow (caret movement); the shortcut yields there.

## Acceptance

- [x] Alt+Arrow snaps the selected node into halves/quarters of the visible canvas, Alt+Up maximises, Alt+Down restores
- [x] With two nodes selected, Alt+Left/Right puts them side by side and Alt+Up/Down stacks them
- [x] The header fit button and Alt+Up are the same maximise; restoring from either returns the node to its pre-snap geometry
- [x] Snapped nodes follow the canvas when the window, sidebar or docked panels resize
- [x] Dragging or resizing a snapped node releases it
- [x] Ctrl+Shift+A and the tile button lay nodes into the viewport, cycling grid → columns → rows
- [x] Alt+Shift+S matches sizes to the first selected node
- [x] Alt+Shift+1..9 / Alt+1..9 save and restore layout slots, persisted with the workspace
- [x] A maximised node is persisted at its pre-snap geometry; other nodes persist where they render
- [x] Pure logic is unit tested; the prototype panel and prototype files do not exist on main
