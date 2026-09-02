import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { resolveToucanSkillsRoot, sessionSkillsConfiguration } from '../src/main/acp-session-manager'

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
