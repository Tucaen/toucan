import type { ProjectGroup, WorkspaceProject } from '../../shared/terminal'

/**
 * Everything the project sidebar's drag-to-reorder knows about geometry and ordering, kept out of
 * `App.tsx` so "where does this row land" can be reasoned about without a DOM.
 *
 * There is no `order` field anywhere: array order *is* display order, exactly as it was before
 * groups existed. The sidebar renders groups first in `projectGroups` order - each followed by the
 * members of `projects` carrying its id - and then the ungrouped projects in `projects` order, so
 * `projects` stays the single ordered list the remote projection already maps.
 */

export interface RowRect {
  top: number
  bottom: number
}

/**
 * The insertion index a pointer implies among a run of rows: a row is claimed from its midpoint
 * down, so 0 means "above everything" and `rows.length` means "below everything".
 */
export function dropIndexFromPointer(rows: readonly RowRect[], pointerY: number): number {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (pointerY < (row.top + row.bottom) / 2) return index
  }
  return rows.length
}

/** A measured sidebar row, in render order. Group headers are drop targets in their own right. */
export interface MeasuredRow extends RowRect {
  kind: 'group-header' | 'project'
  /** The group's id for a header row, the project's id for a project row. */
  id: string
  /** For a project row, the group it currently sits in; absent means top level. */
  groupId?: string
}

/** Where a project lands. Pure ordering: no geometry, so a menu can ask for one too. */
export interface ProjectPlacement {
  /** The group the project joins; absent means top level. */
  groupId?: string
  /** The project it lands in front of, or `null` to land last in that region. */
  beforeProjectId: string | null
}

export interface ProjectDropTarget extends ProjectPlacement {
  /** Where the drop indicator line is drawn, in the same coordinates the rows were measured in. */
  indicatorY: number
}

interface Slot extends ProjectDropTarget {
  /** Set for a group header, whose whole band claims the pointer so a collapsed group is droppable. */
  band?: RowRect
}

function projectSlots(rows: readonly MeasuredRow[], draggedProjectId: string): Slot[] {
  const slots: Slot[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.kind === 'group-header') {
      // A header stands for its whole group: dropping on it lands in front of the first member it
      // shows, or - for a collapsed, empty, or dragged-out-of group - simply inside it. The
      // dragged row is never its own anchor, or dropping onto the header of the group it already
      // leads would fall through to a slot outside that group.
      const firstMember = rows
        .slice(index + 1)
        .find((candidate) => candidate.kind === 'project' && candidate.id !== draggedProjectId)
      const beforeProjectId = firstMember?.groupId === row.id ? firstMember.id : null
      slots.push({ groupId: row.id, beforeProjectId, indicatorY: row.bottom, band: row })
      continue
    }
    if (row.id !== draggedProjectId) {
      slots.push({ groupId: row.groupId, beforeProjectId: row.id, indicatorY: row.top })
    }
    const next = rows[index + 1]
    if (!next || next.kind === 'group-header' || next.groupId !== row.groupId) {
      slots.push({ groupId: row.groupId, beforeProjectId: null, indicatorY: row.bottom })
    }
  }
  return slots
}

function withoutBand(slot: Slot): ProjectDropTarget {
  const { band: _band, ...target } = slot
  return target
}

/**
 * Where the project being dragged would land if the pointer were released at `pointerY`. Returns
 * `null` when nothing was measured; a target that turns out to change nothing is `moveProject`'s
 * business, not this function's.
 */
export function projectDropTarget(
  rows: readonly MeasuredRow[],
  pointerY: number,
  draggedProjectId: string
): ProjectDropTarget | null {
  const usable = projectSlots(rows, draggedProjectId)
  if (usable.length === 0) return null

  // A group header claims its own band outright; otherwise the nearest indicator line wins.
  const overHeader = usable.find((slot) => slot.band && pointerY >= slot.band.top && pointerY < slot.band.bottom)
  if (overHeader) return withoutBand(overHeader)

  let nearest = usable[0]
  for (const slot of usable) {
    if (Math.abs(slot.indicatorY - pointerY) < Math.abs(nearest.indicatorY - pointerY)) nearest = slot
  }
  return withoutBand(nearest)
}

function insertAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = items.slice()
  next.splice(index, 0, item)
  return next
}

/** True when two orderings would render identically, so nothing needs to be written. */
function sameOrder(before: readonly WorkspaceProject[], after: readonly WorkspaceProject[]): boolean {
  return before.every((project, index) => {
    const candidate = after[index]
    return project.id === candidate.id && project.groupId === candidate.groupId
  })
}

/**
 * Moves `projectId` to `placement`, rewriting its `groupId` and splicing it into the target
 * position in `projects`. Appending into an empty region leaves it where it was, because an empty
 * region says nothing about position. A move that changes nothing returns the array it was given,
 * so releasing a drag where it started cannot re-serialise the whole workspace.
 */
export function moveProject(
  projects: WorkspaceProject[],
  projectId: string,
  placement: ProjectPlacement
): WorkspaceProject[] {
  const moving = projects.find((project) => project.id === projectId)
  // A placement anchored on the dragged project itself says "leave it alone", not "append it".
  if (!moving || placement.beforeProjectId === projectId) return projects

  const { groupId: _current, ...bare } = moving
  const moved: WorkspaceProject = placement.groupId ? { ...bare, groupId: placement.groupId } : bare
  const rest = projects.filter((project) => project.id !== projectId)

  const next = ((): WorkspaceProject[] => {
    if (placement.beforeProjectId) {
      const at = rest.findIndex((project) => project.id === placement.beforeProjectId)
      if (at !== -1) return insertAt(rest, at, moved)
    }
    let lastInRegion = -1
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index].groupId === placement.groupId) lastInRegion = index
    }
    return insertAt(rest, lastInRegion === -1 ? projects.indexOf(moving) : lastInRegion + 1, moved)
  })()

  return sameOrder(projects, next) ? projects : next
}

export interface GroupPlacement {
  /** The group it lands in front of, or `null` to land last. */
  beforeGroupId: string | null
}

export interface GroupDropTarget extends GroupPlacement {
  indicatorY: number
}

/** The same maths for group headers, which re-order `projectGroups` and never nest. */
export function groupDropTarget(
  rows: readonly MeasuredRow[],
  pointerY: number,
  draggedGroupId: string
): GroupDropTarget | null {
  const headers = rows.filter((row) => row.kind === 'group-header')
  if (headers.length === 0) return null
  const index = dropIndexFromPointer(headers, pointerY)
  const before = headers[index]
  if (before?.id === draggedGroupId) return null
  const previous = headers[index - 1]
  if (!before && previous?.id === draggedGroupId) return null
  return {
    beforeGroupId: before?.id ?? null,
    indicatorY: before ? before.top : headers[headers.length - 1].bottom
  }
}

export function moveGroup(groups: ProjectGroup[], groupId: string, placement: GroupPlacement): ProjectGroup[] {
  const moving = groups.find((group) => group.id === groupId)
  if (!moving || placement.beforeGroupId === groupId) return groups
  const rest = groups.filter((group) => group.id !== groupId)
  const at = placement.beforeGroupId ? rest.findIndex((group) => group.id === placement.beforeGroupId) : -1
  const next = insertAt(rest, at === -1 ? rest.length : at, moving)
  return next.every((group, index) => group.id === groups[index].id) ? groups : next
}

/**
 * Deleting a group only unfiles its members: a group action must never remove a project, and the
 * members keep their relative order because `projects` itself is left alone.
 */
export function ungroupProjects(projects: readonly WorkspaceProject[], groupId: string): WorkspaceProject[] {
  return projects.map((project) => {
    if (project.groupId !== groupId) return project
    const { groupId: _removed, ...bare } = project
    return bare
  })
}

/** The default name a new group is offered under: the first `Group N` nobody is using. */
export function nextGroupName(groups: readonly ProjectGroup[]): string {
  const taken = new Set(groups.map((group) => group.name))
  for (let index = 1; ; index += 1) {
    const candidate = `Group ${index}`
    if (!taken.has(candidate)) return candidate
  }
}

/** The rows the sidebar renders, in order: each group and the members it shows, then the rest. */
export interface SidebarRegion {
  group?: ProjectGroup
  projects: WorkspaceProject[]
}

export function sidebarRegions(
  projects: readonly WorkspaceProject[],
  groups: readonly ProjectGroup[]
): SidebarRegion[] {
  const grouped = groups.map((group) => ({
    group,
    projects: projects.filter((project) => project.groupId === group.id)
  }))
  return [...grouped, { projects: projects.filter((project) => !project.groupId) }]
}
