import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('renders the WSL crew backend as informational rather than a warning', () => {
  const panel = readFileSync(join(process.cwd(), 'src/renderer/src/FirstMatePanel.tsx'), 'utf8')
  const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  assert.match(
    panel,
    /className="firstmate-worker-info"[^>]*>[\s\S]*?Crew backend: tmux/,
    'the crew backend row should use an informational class'
  )
  assert.doesNotMatch(
    panel,
    /className="firstmate-worker-warning"[^>]*>[\s\S]*?Crew backend: tmux/,
    'the crew backend row must not be presented as a warning'
  )

  const infoRule = styles.match(/\.firstmate-worker-info\s*\{([^}]*)\}/)?.[1]
  assert.ok(infoRule, 'the crew backend informational style should exist')
  assert.doesNotMatch(infoRule, /#c9ad68|#211d14|#4f4529/i, 'the informational style must not use the warning palette')
})
