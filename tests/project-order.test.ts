import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  dropIndexFromPointer,
  groupDropTarget,
  moveGroup,
  moveProject,
  nextGroupName,
  projectDropTarget,
  sidebarRegions,
  ungroupProjects,
  type MeasuredRow
} from '../src/renderer/src/project-order'
import type { ProjectGroup, WorkspaceProject } from '../src/shared/terminal'

/**
 * The sidebar's ordering maths. Array order is display order everywhere here, so these tests are
 * about one thing: a drag can move a project or a group, and it can file a project into a group,
 * but it can never lose one.
 */

function project(id: string, groupId?: string): WorkspaceProject {
  return { id, name: id, path: `D:\\${id}`, color: '#71a9ff', ...(groupId ? { groupId } : {}) }
}

function group(id: string, collapsed = false): ProjectGroup {
  return { id, name: id, collapsed }
}

const ROW_HEIGHT = 40

function rows(...descriptors: MeasuredRow[]): MeasuredRow[] {
  return descriptors
}

function projectRow(id: string, index: number, groupId?: string): MeasuredRow {
  return {
    kind: 'project',
    id,
    ...(groupId ? { groupId } : {}),
    top: index * ROW_HEIGHT,
    bottom: index * ROW_HEIGHT + ROW_HEIGHT
  }
}

function headerRow(id: string, index: number): MeasuredRow {
  return { kind: 'group-header', id, top: index * ROW_HEIGHT, bottom: index * ROW_HEIGHT + ROW_HEIGHT }
}

const ids = (projects: readonly WorkspaceProject[]): string[] => projects.map((entry) => entry.id)

describe('dropIndexFromPointer', () => {
  const three = [
    { top: 0, bottom: 40 },
    { top: 40, bottom: 80 },
    { top: 80, bottom: 120 }
  ]

  test('a row is claimed from its midpoint down', () => {
    assert.equal(dropIndexFromPointer(three, 0), 0)
    assert.equal(dropIndexFromPointer(three, 19), 0)
    assert.equal(dropIndexFromPointer(three, 21), 1)
    assert.equal(dropIndexFromPointer(three, 61), 2)
  })

  test('above and below everything are the two ends', () => {
    assert.equal(dropIndexFromPointer(three, -500), 0)
    assert.equal(dropIndexFromPointer(three, 5000), 3)
    assert.equal(dropIndexFromPointer([], 10), 0)
  })
})

describe('dropping a project', () => {
  const flat = rows(projectRow('a', 0), projectRow('b', 1), projectRow('c', 2))

  test('lands in front of the row the pointer is over', () => {
    assert.deepEqual(projectDropTarget(flat, 45, 'a'), {
      groupId: undefined,
      beforeProjectId: 'b',
      indicatorY: 40
    })
    assert.deepEqual(projectDropTarget(flat, 75, 'a'), {
      groupId: undefined,
      beforeProjectId: 'c',
      indicatorY: 80
    })
  })

  test('lands last when the pointer is past every row', () => {
    assert.deepEqual(projectDropTarget(flat, 400, 'a'), {
      groupId: undefined,
      beforeProjectId: null,
      indicatorY: 120
    })
  })

  test('never offers the dragged row as its own destination', () => {
    const target = projectDropTarget(flat, 0, 'a')
    assert.notEqual(target?.beforeProjectId, 'a')
  })

  test('a header keeps the drag inside its group even when the dragged row leads it', () => {
    const grouped = rows(headerRow('g1', 0), projectRow('a', 1, 'g1'), projectRow('b', 2, 'g1'))
    assert.deepEqual(projectDropTarget(grouped, 20, 'a'), {
      groupId: 'g1',
      beforeProjectId: 'b',
      indicatorY: 40
    })
  })

  test('a group header claims its whole band, so a collapsed group is droppable', () => {
    const grouped = rows(headerRow('g1', 0), projectRow('a', 1))
    const target = projectDropTarget(grouped, 20, 'a')
    assert.deepEqual(target, { groupId: 'g1', beforeProjectId: null, indicatorY: 40 })
  })

  test('an expanded group header lands the project in front of its first member', () => {
    const grouped = rows(headerRow('g1', 0), projectRow('a', 1, 'g1'), projectRow('b', 2))
    assert.deepEqual(projectDropTarget(grouped, 10, 'b'), {
      groupId: 'g1',
      beforeProjectId: 'a',
      indicatorY: 40
    })
  })

  test('returns nothing when there is no row to measure against', () => {
    assert.equal(projectDropTarget([], 10, 'a'), null)
  })
})

describe('moveProject', () => {
  const projects = [project('a'), project('b'), project('c')]

  test('re-orders within the top level', () => {
    const moved = moveProject(projects, 'c', { beforeProjectId: 'a' })
    assert.deepEqual(ids(moved), ['c', 'a', 'b'])
  })

  test('appending puts the project last', () => {
    const moved = moveProject(projects, 'a', { beforeProjectId: null })
    assert.deepEqual(ids(moved), ['b', 'c', 'a'])
  })

  test('files a project into a group and splices it beside its new siblings', () => {
    const withGroup = [project('a', 'g1'), project('b'), project('c')]
    const moved = moveProject(withGroup, 'c', { groupId: 'g1', beforeProjectId: 'a' })
    assert.deepEqual(ids(moved), ['c', 'a', 'b'])
    assert.equal(moved[0].groupId, 'g1')
  })

  test('dropping into an empty group only changes the membership', () => {
    const moved = moveProject(projects, 'b', { groupId: 'g1', beforeProjectId: null })
    assert.deepEqual(ids(moved), ['a', 'b', 'c'])
    assert.equal(moved[1].groupId, 'g1')
  })

  test('dropping into the ungrouped region clears the group', () => {
    const withGroup = [project('a', 'g1'), project('b')]
    const moved = moveProject(withGroup, 'a', { beforeProjectId: null })
    assert.equal('groupId' in moved[1], false)
    assert.deepEqual(ids(moved), ['b', 'a'])
  })

  test('a move that changes nothing returns the very array it was given', () => {
    // Referential identity is the point: `setProjects` would otherwise re-render and re-serialise
    // the whole workspace for a drag released where it started.
    assert.equal(moveProject(projects, 'zz', { beforeProjectId: 'a' }), projects)
    assert.equal(moveProject(projects, 'b', { beforeProjectId: 'b' }), projects)
    assert.equal(moveProject(projects, 'c', { beforeProjectId: null }), projects)
  })
})

describe('dragging a group header', () => {
  const headers = rows(headerRow('g1', 0), headerRow('g2', 1), headerRow('g3', 2))

  test('re-orders groups and never reports a no-op', () => {
    assert.deepEqual(groupDropTarget(headers, 5, 'g3'), { beforeGroupId: 'g1', indicatorY: 0 })
    assert.equal(groupDropTarget(headers, 5, 'g1'), null)
    assert.equal(groupDropTarget(headers, 500, 'g3'), null)
  })

  test('moveGroup splices the header into the new position', () => {
    const groups = [group('g1'), group('g2'), group('g3')]
    assert.deepEqual(
      moveGroup(groups, 'g3', { beforeGroupId: 'g1' }).map((entry) => entry.id),
      ['g3', 'g1', 'g2']
    )
    assert.deepEqual(
      moveGroup(groups, 'g1', { beforeGroupId: null }).map((entry) => entry.id),
      ['g2', 'g3', 'g1']
    )
  })
})

describe('ungroupProjects', () => {
  test('returns the members to the top level in their existing relative order', () => {
    const projects = [project('a', 'g1'), project('b'), project('c', 'g1')]
    const ungrouped = ungroupProjects(projects, 'g1')
    assert.deepEqual(ids(ungrouped), ['a', 'b', 'c'])
    assert.deepEqual(
      ungrouped.map((entry) => entry.groupId),
      [undefined, undefined, undefined]
    )
    assert.equal('groupId' in ungrouped[0], false)
  })
})

describe('nextGroupName', () => {
  test('skips the names already in use', () => {
    assert.equal(nextGroupName([]), 'Group 1')
    assert.equal(nextGroupName([group('a'), { id: 'b', name: 'Group 1', collapsed: false }]), 'Group 2')
  })
})

describe('sidebarRegions', () => {
  test('renders groups first in group order, then the ungrouped projects', () => {
    const projects = [project('a'), project('b', 'g2'), project('c', 'g1'), project('d')]
    const regions = sidebarRegions(projects, [group('g1'), group('g2')])
    assert.deepEqual(
      regions.map((region) => [region.group?.id ?? null, ids(region.projects)]),
      [
        ['g1', ['c']],
        ['g2', ['b']],
        [null, ['a', 'd']]
      ]
    )
  })
})
