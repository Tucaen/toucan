# Worktree UX: a home for each task

Status: direction A2 selected by the user, 2026-09-28. Decided through local throwaway prototypes that were discarded after the decision; the accepted design is captured here and in the implementation issues [#23](https://github.com/Tucaen/toucan/issues/23)–[#28](https://github.com/Tucaen/toucan/issues/28).

## Accepted direction

The worktree contains a canvas of **ordinary chat nodes**. Reuse the existing worktree node as the canvas host and the existing `terminalNode` / `ChatNode` for each chat. Introduce no new registered or persisted node kind, no replacement chat UI, and no session tabs as the primary containment model.

Choose Codex or Claude when creating the worktree; the choice creates its first ordinary chat. Explicit “+ Codex” and “+ Claude” actions add further chats side by side. Provider belongs to each session, not to the worktree. Model, effort and permission choices remain in the normal chat controls. Two chats in the same worktree can therefore use different providers and models.

Each worktree frame hosts a nested canvas: dragging/resizing a chat affects that child; dragging the outer header moves the worktree group. Inner canvases have their own pan/zoom and Fit chats action. Collapse and focus keep chat components mounted. A short worktree navigator preserves orientation while focusing a group — an overview aid, not a replacement of the canvas with a single conversation.

Density refinement: one compact bottom row with Add chat (Codex/Claude) and Fit chats. There is no separate toolbar above the canvas, no Canvas details button and no worktree-level Close selected chat action; the recovered toolbar height goes to the canvas. Session closing remains a normal per-node lifecycle action.

## Problem and intended result

Creating five worktrees currently produces five metadata nodes, then up to five separately placed chat nodes. The user has to remember which conversation belongs to which checkout. Most worktrees have one chat, but the interface makes the user assemble that relationship manually.

Make the worktree the visible unit of work. Creating a worktree opens its first chat inside it. Extra sessions are available inside that same container without making them the default workflow. Task name, branch, activity and pending decisions stay legible when several worktrees run in parallel.

## Alternatives considered

| Direction | Layout and ownership | Five-worktree overview | Main tradeoff |
| --- | --- | --- | --- |
| A2 — Nested canvas (selected) | Each movable worktree frame contains a canvas of ordinary chat nodes. Several chats are visible side by side, with individual positions, sizes, providers and models. | Spatial positions and collapsed groups preserve context; focus provides room to work. | Must make inner versus outer navigation unambiguous and preserve chat lifetimes. |
| B — Overview + focus | All worktrees remain in a navigator; one worktree and its enclosed chat fill the main area. | All five task names, branches and statuses remain visible while reading a full conversation. | Strongest compact overview, but conversations cannot be read side by side. |
| C — Worktree lanes | A stable lane per worktree; the selected lane expands to show the chat, others retain summaries. | Stable ordering allows quick progress comparison. | At laptop widths, five lanes require horizontal scrolling. Additional worktrees worsen this. |

The user selected A and clarified that the children must be normal chat nodes — an earlier tabbed, simplified chat rendering was rejected in favor of A2's real `ChatNode` instances. B and C are historical references, not proposed shipping modes.

## Shared behavior to implement

- **Creation:** one action creates the worktree and opens a chat using the chosen/default provider. Keep advanced branch/base/setup controls available. Focus its composer once it is usable. Do not send a prompt or run setup implicitly unless that is an explicit part of the chosen creation flow.
- **Visible containment:** task name first, branch second. Keep directory/base details in a disclosure. Chat, terminal and change-review surfaces opened from the worktree should have an obvious home inside it.
- **Additional sessions:** “+ Codex” / “+ Claude” creates another ordinary chat node on the inner canvas. Keep both visible, movable and resizable. Each keeps its own model and conversation while sharing checkout files.
- **Overview:** show aggregate activity and attention per worktree. Pending decisions/sign-in failures must remain discoverable when a group is collapsed or another chat is selected. Keep attention distinct from git state: a clean checkout does not mean the agent is finished.
- **Lifecycle:** closing a chat closes that session only. Closing the last chat leaves a worktree with a “New chat” affordance. Collapse, focus and navigation never stop agents. Worktree removal stays a separate explicit action behind the existing evidence-based checks.
- **Creation recovery:** if git creation succeeds but chat startup fails, retain the new worktree and show retry/start-chat inside it; retry must not create another checkout. If creation fails, retain the form values and create no phantom chat.

## Implementation sequence

Tracked as issues [#23](https://github.com/Tucaen/toucan/issues/23) (creation flow), [#24](https://github.com/Tucaen/toucan/issues/24) (canvas containment), [#25](https://github.com/Tucaen/toucan/issues/25) (navigation/focus), [#26](https://github.com/Tucaen/toucan/issues/26) (opening/lifecycle containment), [#27](https://github.com/Tucaen/toucan/issues/27) (overview/attention) and [#28](https://github.com/Tucaen/toucan/issues/28) (terminals, reviews and edges), with native blocked-by dependencies.

1. **Ship the default creation flow.** Extend `WorktreeCreateDialog` in `src/renderer/src/WorkspaceDialogs.tsx` and `confirmWorktreeDraft` in `src/renderer/src/App.tsx`. Register the successfully created worktree, then use the existing `addSessionNode` path with that worktree and provider. Handle partial success explicitly. Keep existing worktrees and sessions intact.
2. **Turn the existing worktree node into a canvas host.** Evolve `src/renderer/src/WorktreeNode.tsx` and `src/renderer/src/canvas-workspace.ts`; reuse `src/renderer/src/ChatNode.tsx` unchanged for children. Keep persisted `worktreeId` as the attachment authority, derive canvas membership from it, and store child-relative geometry and any inner viewport without duplicating ownership. A separate React Flow instance per worktree matches the evaluated behavior; production must scope node lookup, selection, fit/snap, shortcuts and edge routing to the appropriate canvas while retaining one workspace state authority. Never mount one session in two places or remount it on focus/collapse. Preserve node IDs, conversation IDs, cwd and session effects.
3. **Add overview and aggregate status.** Derive per-worktree summaries from existing node state and attention records in `src/shared/attention.ts`. Reuse the same summaries across container headers and any navigator. Never clear a pending decision merely because its group was visited; opening a hidden session must reveal that session before marking readable results viewed.
4. **Migrate and verify.** Load existing standalone worktree/chat layouts into the selected presentation without starting extra sessions. Cover handoff-created and discovered worktrees, branches reopened from history, missing worktrees, and existing multi-session worktrees. Update tile, snap, fit, resize, drag and restored geometry together. Keep lineage and terminal-context edges visible/meaningful across containment. A terminal inside a group still grants no agent read capability without its explicit edge.

Production acceptance checks: one new worktree gets exactly one chat in the correct cwd; startup retry never duplicates the checkout; collapsing or switching worktrees preserves an active turn, draft and scroll; several sessions retain their individual transcripts and attention; all five tasks remain discoverable; closing a chat does not remove files; the existing removal blockers still apply. Use focused integration coverage plus hands-on keyboard, layout and restore checks at laptop and wide-monitor sizes.

## Architectural boundaries

The worktree remains a first-class persisted entity. UI encapsulation does not make its filesystem lifetime a side effect of a chat. `src/renderer/src/worktree-attachment.ts` still owns attachment/count rules; `src/main/git-worktree.ts` still owns removal evidence. A diff can be visually contained without becoming an attached running session or a deletion blocker. Parent movement is geometry only, not a cwd change or agent restart. Missing-worktree sessions must retain their detached/dormant behavior.

The prototypes exercised real inner React Flow canvases with the actual `ChatNode` against a simulated agent bridge, but proved nothing about real agent startup, git creation, cross-canvas edges, nested snap, migration or persistence — those are implementation requirements carried by the issues above. Production must aggregate actual session attention and liveness.
