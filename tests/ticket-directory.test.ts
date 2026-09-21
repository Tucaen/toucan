import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { ticketsDirectoryFor } from '../src/main/ticket-directory'
import type { WorkspaceProject } from '../src/shared/terminal'
import { DEFAULT_TICKETS_DIRECTORY, isTicketsDirectory } from '../src/shared/tickets'

const PROJECT = 'D:\\Development\\Toucan'

function project(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return { id: 'toucan', name: 'Toucan', path: PROJECT, color: '#71a9ff', ...overrides }
}

const defaultFolder = resolve(PROJECT, DEFAULT_TICKETS_DIRECTORY)

test('a registered project gets its default folder and an unknown project is refused', () => {
  assert.equal(ticketsDirectoryFor(PROJECT, [project()]), defaultFolder)
  assert.throws(() => ticketsDirectoryFor(PROJECT, []), /not registered/)
})

test('a project may point at its own folder inside the checkout', () => {
  assert.equal(
    ticketsDirectoryFor(PROJECT, [project({ ticketsDirectory: ' notes/tickets ' })]),
    resolve(PROJECT, 'notes/tickets')
  )
})

test('the project is found even when the snapshot disagrees about the drive letter’s case', () => {
  assert.equal(
    ticketsDirectoryFor('d:\\development\\toucan', [project({ ticketsDirectory: 'notes/tickets' })]),
    resolve('d:\\development\\toucan', 'notes/tickets')
  )
})

test('a setting that escapes the checkout is ignored rather than obeyed', () => {
  for (const escape of ['../../elsewhere', 'C:\\Windows\\Temp', '/etc', '\\\\server\\share', 'docs/../../out', '  ']) {
    assert.equal(ticketsDirectoryFor(PROJECT, [project({ ticketsDirectory: escape })]), defaultFolder)
  }
})

test('the rule about what a tickets folder may be is stated once, and says what it means', () => {
  assert.equal(isTicketsDirectory('docs/tickets'), true)
  assert.equal(isTicketsDirectory('tickets'), true)
  assert.equal(isTicketsDirectory('docs\\tickets'), true)
  assert.equal(isTicketsDirectory('../tickets'), false)
  assert.equal(isTicketsDirectory('C:/tickets'), false)
  assert.equal(isTicketsDirectory('/tickets'), false)
  assert.equal(isTicketsDirectory(''), false)
})
