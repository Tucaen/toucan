import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'
import { createCodexPluginSkills } from '../src/main/codex-plugin-skills'

// #55: codex-acp only finds skills under `<additional directory>/.agents/skills`, so a plugin's
// `skills/` reaches Codex through a Toucan-owned directory that links there.

function skillsFolder(): string {
  const skills = join(mkdtempSync(join(tmpdir(), 'toucan-codex-plugin-')), 'skills')
  mkdirSync(join(skills, 'run-scene'), { recursive: true })
  writeFileSync(join(skills, 'run-scene', 'SKILL.md'), '---\nname: run-scene\n---\n')
  return skills
}

test("a plugin folder's skills get a link of their own, which nothing ever re-points", async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'toucan-codex-plugin-user-data-'))
  const links = createCodexPluginSkills(userDataPath)
  const skills = skillsFolder()

  const root = await links.rootFor('godot-runtime', skills)
  assert.equal(dirname(root), join(userDataPath, 'codex-plugin-skills'))
  assert.equal(realpathSync(join(root, '.agents', 'skills')), realpathSync(skills))
  assert.equal(await links.rootFor('godot-runtime', skills), root)

  // The same id from another folder - removed and added again - gets its own link, so a Codex
  // session still running on the first one keeps the skills its instruction names.
  const moved = skillsFolder()
  const movedRoot = await links.rootFor('godot-runtime', moved)
  assert.notEqual(movedRoot, root)
  assert.equal(realpathSync(join(movedRoot, '.agents', 'skills')), realpathSync(moved))
  assert.equal(realpathSync(join(root, '.agents', 'skills')), realpathSync(skills))
})

test('anything but a link where the link belongs is left alone and reported', async () => {
  const links = createCodexPluginSkills(mkdtempSync(join(tmpdir(), 'toucan-codex-plugin-user-data-')))
  const skills = skillsFolder()
  const root = await links.rootFor('godot-runtime', skills)
  const link = join(root, '.agents', 'skills')
  unlinkSync(link)
  mkdirSync(link)
  writeFileSync(join(link, 'notes.md'), "Not Toucan's.")

  await assert.rejects(links.rootFor('godot-runtime', skills), /not a link Toucan made/)
})
