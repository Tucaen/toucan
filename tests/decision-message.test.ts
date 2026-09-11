import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  classifyAssistantMessage,
  decisionQuestions,
  extractDecisionOptions
} from '../src/renderer/src/decision-message'

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

test('an enumerated ticket proposal followed by one confirmation question offers Agree, not the tickets', () => {
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
    'Does this proposal look good?'
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

test('numbered discussion points followed by a closing paragraph ending on a question are not a decision', () => {
  const text = [
    'Two things to decide:',
    '',
    '1. **Collapsed sidebar** — `creation-target` only renders when `!sidebarCollapsed`. The controls should probably stay visible when collapsed (icon-only, like the Tickets button), otherwise you lose zoom controls entirely in collapsed mode.',
    '2. **Discoverability trade-off** — zoom controls next to the canvas is the convention users know. Sidebar placement is fine for a power-user tool like this, but it is slightly less discoverable.',
    '',
    'The lazier alternative — keeping `<Controls>` but passing `fitViewOptions={{ padding: ... }}` so fit-view leaves room — only hides the symptom; nodes still slide under the controls when you pan. I would do the sidebar move. Want me to implement it?'
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

test('several trailing review questions remain prose instead of sharing one Agree answer', () => {
  const text = [
    'Six tickets, ready to write:',
    '',
    '1. **Next installment skips charged rates**',
    '2. **Document upload rejects PDFs**',
    '',
    'Questions:',
    '',
    '1. **Screenshot 2** — which app is that? It may be out of scope here.',
    '2. **Granularity** — happy with 6, or should I merge 2 into 1 (giving 3 tickets total)?',
    '3. Should tickets 1-6 get a **parent reference to CICBP-384** in their bodies?'
  ].join('\n')

  assert.equal(classifyAssistantMessage(text), 'normal')
  assert.deepEqual(extractDecisionOptions(text), [])
  assert.deepEqual(decisionQuestions(text), [
    'Screenshot 2 — which app is that? It may be out of scope here.',
    'Granularity — happy with 6, or should I merge 2 into 1 (giving 3 tickets total)?',
    'Should tickets 1-6 get a parent reference to CICBP-384 in their bodies?'
  ])
})

test('a choice decision reports only its trailing question, not the option lines', () => {
  const text = [
    'The lint gate failed on the unused import. I can:',
    '',
    '- **Fix it now**: remove the unused import and rerun the gate',
    '- **Skip it**: leave the file as-is',
    '',
    'Which would you like?'
  ].join('\n')

  assert.deepEqual(decisionQuestions(text), ['Which would you like?'])
})

test('a message with no trailing question reports no questions', () => {
  assert.deepEqual(decisionQuestions('I removed the unused import and the gate is green.'), [])
  assert.deepEqual(decisionQuestions(''), [])
})

test('an option line ending on a question mark is not reported as one of the questions', () => {
  const text = [
    'Two ways to proceed:',
    '- **Fix it now**: remove the unused import?',
    '- **Skip it**: leave the file as-is?',
    'Which would you like?'
  ].join('\n')

  assert.deepEqual(decisionQuestions(text), ['Which would you like?'])
})
