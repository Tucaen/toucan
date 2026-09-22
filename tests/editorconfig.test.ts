import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { editorConfigOptions } from '../src/main/editorconfig'

/*
 * `.editorconfig` is often the only place a project states its style, so format-on-save reads it
 * as the base under any Prettier file. What matters here is the search - how far up it goes and
 * where it stops - and the glob dialect, which is EditorConfig's own and not Prettier's ignore
 * syntax. `tests/file-formatter.test.ts` covers what the resulting options do to a save.
 */

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'toucan-editorconfig-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('reads the settings for the sections that match the file, and no others', async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, '.editorconfig'),
      [
        'root = true',
        '',
        '[*]',
        'indent_style = space',
        'indent_size = 4',
        'max_line_length = 100',
        '',
        '[*.{ts,tsx}]',
        'quote_type = single',
        '',
        '[*.md]',
        'max_line_length = 60'
      ].join('\n'),
      'utf8'
    )

    assert.deepEqual(await editorConfigOptions(join(root, 'src', 'index.tsx'), root), {
      useTabs: false,
      tabWidth: 4,
      printWidth: 100,
      singleQuote: true
    })
    assert.deepEqual(await editorConfigOptions(join(root, 'README.md'), root), {
      useTabs: false,
      tabWidth: 4,
      printWidth: 60
    })
  })
})

test('a setting closer to the file wins, and root = true ends the search', async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'outer', 'inner'), { recursive: true })
    await writeFile(join(root, '.editorconfig'), '[*]\nmax_line_length = 40\nindent_style = tab\n', 'utf8')
    await writeFile(join(root, 'outer', '.editorconfig'), 'root = true\n\n[*]\nindent_size = 2\n', 'utf8')
    await writeFile(join(root, 'outer', 'inner', '.editorconfig'), '[*]\nindent_size = 8\n', 'utf8')

    // The nearest wins over the one above it, and nothing above `outer` is read at all.
    assert.deepEqual(await editorConfigOptions(join(root, 'outer', 'inner', 'a.ts'), root), { tabWidth: 8 })
    assert.deepEqual(await editorConfigOptions(join(root, 'outer', 'a.ts'), root), { tabWidth: 2 })
    assert.deepEqual(await editorConfigOptions(join(root, 'a.ts'), root), { useTabs: true, printWidth: 40 })
  })
})

test('the search never climbs out of the workspace root', async () => {
  await withRoot(async (root) => {
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(root, '.editorconfig'), '[*]\nindent_size = 8\n', 'utf8')

    assert.deepEqual(await editorConfigOptions(join(project, 'a.ts'), project), {})
  })
})

test("matches EditorConfig's glob dialect, where a bare pattern matches at any depth", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    await writeFile(
      join(root, '.editorconfig'),
      ['root = true', '', '[*.ts]', 'indent_size = 2', '', '[/src/**/generated.ts]', 'indent_size = 8'].join('\n'),
      'utf8'
    )

    assert.deepEqual(await editorConfigOptions(join(root, 'src', 'deep', 'a.ts'), root), { tabWidth: 2 })
    // A rooted pattern matches only under that directory, and `**` crosses separators.
    assert.deepEqual(await editorConfigOptions(join(root, 'src', 'deep', 'generated.ts'), root), { tabWidth: 8 })
    assert.deepEqual(await editorConfigOptions(join(root, 'src', 'generated.ts'), root), { tabWidth: 8 })
    assert.deepEqual(await editorConfigOptions(join(root, 'generated.ts'), root), { tabWidth: 2 })
  })
})

test('indent_size = tab falls back to tab_width, as EditorConfig defines it', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, '.editorconfig'), '[*]\nindent_style = tab\nindent_size = tab\ntab_width = 3\n', 'utf8')

    assert.deepEqual(await editorConfigOptions(join(root, 'a.ts'), root), { useTabs: true, tabWidth: 3 })
  })
})

test('a file with no .editorconfig anywhere states nothing, rather than guessing', async () => {
  await withRoot(async (root) => {
    assert.deepEqual(await editorConfigOptions(join(root, 'a.ts'), root), {})
  })
})
