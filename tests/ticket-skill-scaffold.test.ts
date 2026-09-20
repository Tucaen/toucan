import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTicketSkillScaffold } from '../src/main/ticket-skill-scaffold'
import { PROJECT_SKILLS_MANIFEST_SEGMENTS } from '../src/shared/project-skills'
import { TICKET_SKILL_NAME, TICKET_SKILL_PATH } from '../src/shared/ticket-skill'
import { DEFAULT_TICKETS_DIRECTORY, readTicket } from '../src/shared/tickets'

const TODAY = '2026-09-20'

function scaffold(): ReturnType<typeof createTicketSkillScaffold> {
  return createTicketSkillScaffold({
    directoryFor: () => DEFAULT_TICKETS_DIRECTORY,
    today: () => TODAY
  })
}

async function withProject(
  run: (project: string, skillFile: string, manifest: string) => Promise<void>
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), 'toucan-skill-'))
  try {
    await run(project, join(project, TICKET_SKILL_PATH), join(project, ...PROJECT_SKILLS_MANIFEST_SEGMENTS))
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

test('a project with no tickets skill reports one it can be given', async () => {
  await withProject(async (project) => {
    assert.deepEqual(await scaffold().state(project), { status: 'absent', path: TICKET_SKILL_PATH })
  })
})

test('scaffolding writes the skill, creating the skills folders on the way', async () => {
  await withProject(async (project, skillFile) => {
    const result = await scaffold().write(project)

    assert.equal(result.ok, true)
    const written = await readFile(skillFile, 'utf8')
    assert.match(written, new RegExp(`^---\\nname: ${TICKET_SKILL_NAME}\\n`))
    // The skill an agent is handed must teach a ticket the board actually renders.
    const example = written.match(/```markdown\n([\s\S]*?)```/)
    assert.ok(example)
    assert.equal(readTicket(example[1], 'ticket-board').status, 'open')
  })
})

/**
 * The skill is only reachable because `.agents` loads as a plugin, and a plugin with no manifest
 * loads nothing - a scaffold that wrote the skill alone would leave a file no agent ever reads
 * while reporting success.
 */
test('scaffolding also writes the plugin manifest that makes the folder loadable', async () => {
  await withProject(async (project, _skillFile, manifest) => {
    await scaffold().write(project)

    const written = JSON.parse(await readFile(manifest, 'utf8')) as { name: string }
    assert.ok(written.name.length > 0)
  })
})

test('a manifest the project already wrote is left exactly as it is', async () => {
  await withProject(async (project, _skillFile, manifest) => {
    await mkdir(join(manifest, '..'), { recursive: true })
    await writeFile(manifest, '{ "name": "ours" }\n', 'utf8')

    assert.equal((await scaffold().write(project)).ok, true)
    assert.equal(await readFile(manifest, 'utf8'), '{ "name": "ours" }\n')
  })
})

test('a project that already has a tickets skill is refused, not overwritten', async () => {
  await withProject(async (project, skillFile) => {
    await mkdir(join(skillFile, '..'), { recursive: true })
    await writeFile(skillFile, 'The project wrote this itself.\n', 'utf8')

    const result = await scaffold().write(project)

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.code, 'skill-exists')
    assert.equal(await readFile(skillFile, 'utf8'), 'The project wrote this itself.\n')
    assert.equal((await scaffold().state(project)).status, 'present')
  })
})

test('a refusal names the file that stopped it, so the user can go and read it', async () => {
  await withProject(async (project, skillFile) => {
    await mkdir(join(skillFile, '..'), { recursive: true })
    await writeFile(skillFile, 'Mine.\n', 'utf8')

    const result = await scaffold().write(project)

    assert.equal(result.ok, false)
    assert.ok(result.ok === false && result.message.includes(TICKET_SKILL_PATH))
  })
})

test("the scaffolded skill names the project's own tickets folder", async () => {
  await withProject(async (project, skillFile) => {
    const moved = createTicketSkillScaffold({ directoryFor: () => 'notes/work', today: () => TODAY })

    assert.equal((await moved.write(project)).ok, true)
    assert.match(await readFile(skillFile, 'utf8'), /`notes\/work`/)
  })
})

test('a write that loses a race with a hand-written skill still does not clobber it', async () => {
  await withProject(async (project, skillFile) => {
    // The directory exists and is empty, which is the state a half-set-up skill leaves behind.
    await mkdir(join(skillFile, '..'), { recursive: true })

    assert.equal((await scaffold().write(project)).ok, true)
    const second = await scaffold().write(project)
    assert.equal(second.ok, false)
  })
})

test('the path the board is told about is the one the skill names inside itself', async () => {
  await withProject(async (project, skillFile) => {
    await scaffold().write(project)

    assert.equal((await scaffold().state(project)).path, TICKET_SKILL_PATH)
    assert.ok((await readFile(skillFile, 'utf8')).includes(TICKET_SKILL_PATH))
  })
})
