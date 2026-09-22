import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseFlatYaml, parseJson5 } from '../src/main/static-config'

/*
 * The readers behind format-on-save's configuration discovery. What matters here is the pair of
 * promises `file-formatter.ts` makes on top of them: every static form a project may have written
 * its Prettier settings in is read, and anything they cannot account for is a refusal rather than
 * a partial answer - because a partial answer silently reformats the file with Prettier defaults.
 */

test('reads plain JSON, which is what most projects write', () => {
  assert.deepEqual(parseJson5('{"semi": false, "printWidth": 120, "useTabs": true}'), {
    semi: false,
    printWidth: 120,
    useTabs: true
  })
  assert.deepEqual(parseJson5('  {"overrides": [{"files": "*.md", "options": {"proseWrap": "always"}}]}  '), {
    overrides: [{ files: '*.md', options: { proseWrap: 'always' } }]
  })
})

test('reads the JSON5 a .prettierrc.json5 may use', () => {
  assert.deepEqual(
    parseJson5(`{
      // the project's own style
      semi: false,
      singleQuote: true,
      /* block */
      endOfLine: 'auto',
    }`),
    { semi: false, singleQuote: true, endOfLine: 'auto' }
  )
})

test('a comment marker inside a value is part of the value, not the start of a comment', () => {
  assert.deepEqual(parseJson5('{"x": "https://example.com/a", "y": "C:\\\\src//gen"}'), {
    x: 'https://example.com/a',
    y: 'C:\\src//gen'
  })
})

test('malformed JSON is refused rather than half-read', () => {
  assert.throws(() => parseJson5('{"semi": false'), /unclosed object/i)
  assert.throws(() => parseJson5('{"semi": }'), /Expected a value/i)
  assert.throws(() => parseJson5('{"semi": false} trailing'), /Unexpected text/i)
  assert.throws(() => parseJson5('{"semi": /* never closed'), /unclosed block comment/i)
})

test('reads a flat YAML .prettierrc, comments and quoting included', () => {
  assert.deepEqual(
    parseFlatYaml(`# the project's own style
semi: false
singleQuote: true
printWidth: 120
trailingComma: "all"
proseWrap: always   # inline note
`),
    { semi: false, singleQuote: true, printWidth: 120, trailingComma: 'all', proseWrap: 'always' }
  )
})

test('YAML beyond one setting per line is refused, so no half of it is applied', () => {
  assert.throws(() => parseFlatYaml('overrides:\n  - files: "*.md"\n'), /no value on its own line/i)
  assert.throws(() => parseFlatYaml('semi: false\n  indented: true\n'), /plain 'setting: value' line/i)
  assert.throws(() => parseFlatYaml('plugins: [a, b]\n'), /more than the plain settings/i)
})
