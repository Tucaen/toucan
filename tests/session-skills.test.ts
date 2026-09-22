import { strict as assert } from 'node:assert'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  resolveToucanSkillsRoot,
  sessionSkillsConfiguration,
  withAdditionalDirectories
} from '../src/main/acp-session-manager'
import { PROJECT_SKILLS_DIRECTORY } from '../src/shared/project-skills'
import { TICKET_SKILL_NAME } from '../src/shared/ticket-skill'

test('Toucan ships no tickets skill, so a project only ever sees the one it wrote itself', () => {
  // `.agents/skills` is handed to every session Toucan launches, so a tickets skill committed here
  // would be injected into every project at once - the duplicate this repo deliberately has none
  // of. Scaffolding one into this checkout to try the board out is a local experiment, never a
  // commit. The skills named are what Toucan does ship; a new one is a decision, this is a guard.
  const shipped = readdirSync(join(process.cwd(), PROJECT_SKILLS_DIRECTORY, 'skills'))
  assert.ok(!shipped.includes(TICKET_SKILL_NAME), 'Toucan must ship no tickets skill of its own')
  assert.ok(shipped.includes('brain-dump') && shipped.includes('implement-in-worktree'))
})

test('Toucan skills remain available when a Codex node works in another project', () => {
  const toucanRoot = 'D:\\Development\\ADE'
  assert.deepEqual(sessionSkillsConfiguration('codex', 'D:\\Development\\Other', toucanRoot), {
    additionalDirectories: [toucanRoot]
  })
})

test('Claude loads both project-local and Toucan-owned skills for another project', () => {
  const cwd = 'D:\\Development\\Other'
  const toucanRoot = 'D:\\Development\\ADE'
  const available = new Set([joinForTest(cwd, '.agents', 'skills'), joinForTest(toucanRoot, '.agents', 'skills')])
  assert.deepEqual(
    sessionSkillsConfiguration('claude', cwd, toucanRoot, (path) => available.has(String(path))),
    {
      _meta: {
        claudeCode: {
          options: {
            plugins: [
              { type: 'local', path: joinForTest(cwd, '.agents') },
              { type: 'local', path: joinForTest(toucanRoot, '.agents') }
            ]
          }
        }
      }
    }
  )
})

test("a request's own directories join the skills root without duplicates", () => {
  const toucanRoot = 'D:\\Development\\ADE'
  const library = 'C:\\Users\\Ada\\AppData\\Roaming\\toucan\\brain-dumps'
  assert.deepEqual(withAdditionalDirectories({ additionalDirectories: [toucanRoot] }, [library, toucanRoot]), {
    additionalDirectories: [toucanRoot, library]
  })
  const claude = { _meta: { claudeCode: { options: { plugins: [] } } } }
  assert.deepEqual(withAdditionalDirectories(claude, [library]), { ...claude, additionalDirectories: [library] })
  assert.deepEqual(withAdditionalDirectories({}, undefined), {})
})

test('packaged Toucan skills resolve from app.asar.unpacked for native providers', () => {
  const resources = joinForTest('C:\\Program Files\\Toucan', 'resources')
  const unpackedRoot = joinForTest(resources, 'app.asar.unpacked')
  assert.equal(
    resolveToucanSkillsRoot(
      joinForTest(resources, 'app.asar'),
      (path) => path === joinForTest(unpackedRoot, '.agents', 'skills')
    ),
    unpackedRoot
  )
})

function joinForTest(...parts: string[]): string {
  return parts.join(process.platform === 'win32' ? '\\' : '/')
}
