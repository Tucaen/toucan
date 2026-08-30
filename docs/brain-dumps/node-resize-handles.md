---
title: Node resize handles
created: 2026-08-30
updated: 2026-08-30
---

# Node resize handles

Canvas nodes need resize affordances that are easy to acquire from every expected edge, without requiring unusually precise pointer placement.

## Current understanding

- The existing resize handles are too difficult to hit.
- Handles appear to be available at the corners and along the top, but are missing or ineffective along the sides and bottom.
- The hit targets should make resizing from the sides and bottom as discoverable and reliable as resizing from the currently usable areas.

## Open questions

- Are the side and bottom handles absent, visually obscured, clipped, or present with hit areas that are too small?
- What minimum pointer target size provides comfortable resizing without interfering with node selection, dragging, or nearby controls?
