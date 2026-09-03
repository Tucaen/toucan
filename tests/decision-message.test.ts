import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { classifyAssistantMessage, extractDecisionOptions } from '../src/renderer/src/decision-message'

test('a decision-shaped message (labeled options + trailing question) classifies as decision', () => {
  const text = [
    'The lint gate failed on the unused import in auth.ts. I can:',
    '',
    '- **Fix it now**: remove the unused import and rerun the gate',
    '- **Skip it**: leave the file as-is and move on to the next finding',
    '',
    'Which would you like?'
  ].join('\n')

  assert.equal(classifyAssistantMessage(text), 'decision')
})

test('decision options are extracted with clean labels, in order', () => {
  const text = [
    'Two ways to proceed:',
    '- **Fix it now**: remove the unused import and rerun the gate',
    '- **Skip it**: leave the file as-is',
    'Which would you like?'
  ].join('\n')

  const options = extractDecisionOptions(text)
  assert.deepEqual(
    options.map((option) => option.label),
    ['Fix it now: remove the unused import and rerun the gate', 'Skip it: leave the file as-is']
  )
})

test('Codex numbered Markdown options classify without admitting ordinary numbered steps', () => {
  const text = [
    'I need your choice:',
    '1. **Use the cache** — fastest',
    '2. **Read the source** — freshest',
    'Which should I do?'
  ].join('\n')
  assert.equal(classifyAssistantMessage(text), 'decision')
  assert.deepEqual(
    extractDecisionOptions(text).map((option) => option.label),
    ['Use the cache — fastest', 'Read the source — freshest']
  )
})

test('an enumerated ticket proposal followed by confirmation questions offers Agree, not the tickets', () => {
  const text = [
    'Here is the proposed breakdown:',
    '',
    '1. **Persist draft metadata**',
    '   Blocked by: None',
    '   What it delivers: Drafts survive a restart.',
    '2. **Restore drafts in the composer**',
    '   Blocked by: Persist draft metadata',
    '   What it delivers: A reopened node shows its draft.',
    '',
    'Before I publish these:',
    '',
    '- Does the granularity feel right?',
    '- Are the blocking edges correct?',
    '- Should any tickets be merged or split further?'
  ].join('\n')

  assert.equal(classifyAssistantMessage(text), 'decision')
  assert.deepEqual(
    extractDecisionOptions(text).map((option) => option.label),
    ['Agree']
  )
})

test('plain numbered implementation steps followed by approval remain content', () => {
  const text = [
    'Suggested implementation:',
    '1. Add the persistence boundary.',
    '2. Restore the saved draft.',
    '3. Render the restored value.',
    '',
    'Does this plan look good?'
  ].join('\n')

  assert.equal(classifyAssistantMessage(text), 'decision')
  assert.deepEqual(
    extractDecisionOptions(text).map((option) => option.label),
    ['Agree']
  )
})

test('a genuine numbered choice list keeps its choices when the question contains confirmation vocabulary', () => {
  const text = [
    'Choose the release action:',
    '1. **Approve** — publish now',
    '2. **Reject** — return to draft',
    'Which option looks good?'
  ].join('\n')

  assert.deepEqual(
    extractDecisionOptions(text).map((option) => option.label),
    ['Approve — publish now', 'Reject — return to draft']
  )
})

test('a yes-no question about genuine options does not replace them with Agree', () => {
  const text = [
    'Choose an implementation plan:',
    '1. **Approve** — publish now',
    '2. **Reject** — return to draft',
    'Do these options look good?'
  ].join('\n')

  assert.deepEqual(
    extractDecisionOptions(text).map((option) => option.label),
    ['Approve — publish now', 'Reject — return to draft']
  )
})

test('bulleted seam proposals followed by approval offer Agree instead of seam buttons', () => {
  const text = [
    'Suggested seams:',
    '- **Parser seam** — recognize proposal confirmation',
    '- **Renderer seam** — render the resulting action',
    '',
    'Does this proposal look good?'
  ].join('\n')

  assert.deepEqual(
    extractDecisionOptions(text).map((option) => option.label),
    ['Agree']
  )
})

test('a routine/noise message (short status ping, no options, no question) classifies as noise', () => {
  assert.equal(classifyAssistantMessage('Spawning worker for task fm-142 in the alpha project.'), 'noise')
  assert.equal(classifyAssistantMessage('No action needed here — the gate already passed.'), 'noise')
})

test('a normal conversational reply gets neither treatment', () => {
  const text =
    'Here is a summary of what changed in this commit: the auth middleware now validates ' +
    'the session token expiry before allowing a refresh.'
  assert.equal(classifyAssistantMessage(text), 'normal')
})

test('a single option line with a trailing question is not enough to classify as decision', () => {
  const text = ['- **Fix it now**: remove the unused import', 'Should I go ahead?'].join('\n')
  assert.equal(classifyAssistantMessage(text), 'normal')
})

test('two option lines without a trailing question is not enough to classify as decision', () => {
  const text = [
    '- **Fix it now**: remove the unused import',
    '- **Skip it**: leave the file as-is',
    'I will proceed with the fix.'
  ].join('\n')
  assert.equal(classifyAssistantMessage(text), 'normal')
})

test('ordinary numbered step-by-step prose does not false-positive as decision options', () => {
  const text = ['1. Run the build', '2. Check the logs', '3. Report back', 'Does that match what you expected?'].join(
    '\n'
  )
  assert.equal(classifyAssistantMessage(text), 'normal')
})

test('a long technical explanation with emphasized sections and a trailing question is not a decision', () => {
  const text = [
    '**Empfehlung: keins von beidem als eigener Schritt — ein vertikaler Slice**',
    '',
    'Nicht zuerst die UI als Mock-up angleichen. Das ist eine horizontale Schicht.',
    '',
    '**Konkret, ein Slice:**',
    '',
    '1. **Container:** Zeilenklick öffnet die Detail-Komponente.',
    '2. **BAS:** Neuer Request mit vier Sub-DTOs.',
    '3. **NEXT:** Vier Karten read-only rendern.',
    '',
    '**Legacy-Ballast, der jetzt schon entscheidbar ist**',
    '',
    'Die bestehenden Options-Spalten sind ein Workaround, keine auswählbaren Alternativen.',
    '',
    'Zwei Entscheidungen brauche ich von dir:',
    '',
    '1. **Read-only zuerst?** Der Screenshot ist Change mode mit CRUD. Ich würde read-only zuerst schicken.',
    '2. **Ersetzt der Zeilenklick den VP Cockpit-Button oder bleibt der Sprung auf den Baum-Tab daneben stehen?**'
  ].join('\n')

  assert.equal(classifyAssistantMessage(text), 'normal')
  assert.deepEqual(extractDecisionOptions(text), [])
})

test('a long or multi-paragraph message never classifies as noise even with a routine lead-in', () => {
  const text =
    'Spawning worker for task fm-142.\n\nIt will validate the migration against the staging ' +
    'database before touching production, and report back once the dry run finishes.'
  assert.equal(classifyAssistantMessage(text), 'normal')
})

test('empty text classifies as normal', () => {
  assert.equal(classifyAssistantMessage(''), 'normal')
  assert.equal(classifyAssistantMessage('   '), 'normal')
})
