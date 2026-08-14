import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { firstMateProjectContext } from '../src/renderer/src/firstmate-project-context'

test('describes the selected ADE project using paths FirstMate can use from WSL', () => {
  const context = firstMateProjectContext({
    id: 'project-1',
    name: 'My Project',
    path: 'D:\\Development\\My Project',
    color: '#71a9ff'
  })

  assert.match(context, /name: "My Project"/)
  assert.match(context, /path: "\/mnt\/d\/Development\/My Project"/)
  assert.match(context, /Windows path: "D:\\\\Development\\\\My Project"/)
  assert.match(context, /selected in ADE's left sidebar/)
  assert.match(context, /use the absolute path above/)
})

test('changes the FirstMate assignment when the sidebar selection changes', () => {
  const first = firstMateProjectContext({ id: 'one', name: 'One', path: 'C:\\One', color: '#fff' })
  const second = firstMateProjectContext({ id: 'two', name: 'Two', path: 'E:\\Two', color: '#fff' })

  assert.match(first, /"\/mnt\/c\/One"/)
  assert.doesNotMatch(first, /"\/mnt\/e\/Two"/)
  assert.match(second, /"\/mnt\/e\/Two"/)
})
