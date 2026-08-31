import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isBrainDumpSlug } from '../shared/brain-dump'
import { parseBrainDumpTopic } from './brain-dump-library'
import { pathExists, writeNewFileDurably } from './durable-file'

export interface BrainDumpMigrationOptions {
  sourceDirectory: string
  rootDirectory: string
  onPlan?: (plan: readonly string[]) => void
}

export interface BrainDumpMigrationResult {
  ok: boolean
  plan: string[]
  imported: string[]
  skipped: string[]
  failed: Array<{ path: string; message: string }>
}

function convertLegacyLinks(markdown: string, knownSlugs: ReadonlySet<string>): string {
  return markdown.replace(/\[([^\]]+)]\(([^)]+\.md)\)/g, (whole, _label: string, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.includes('\\')) return whole
    const slug = basename(target, '.md')
    return knownSlugs.has(slug) ? `[[${slug}]]` : whole
  })
}

export async function migrateBrainDumps(options: BrainDumpMigrationOptions): Promise<BrainDumpMigrationResult> {
  const result: BrainDumpMigrationResult = { ok: false, plan: [], imported: [], skipped: [], failed: [] }
  let names: string[]
  try {
    names = (await readdir(options.sourceDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    result.failed.push({ path: options.sourceDirectory, message: (error as Error).message })
    return result
  }
  const knownSlugs = new Set(names.map((name) => name.slice(0, -3)))
  const prepared: Array<{ slug: string; markdown: string; destination: string }> = []
  for (const name of names) {
    const slug = name.slice(0, -3)
    const source = join(options.sourceDirectory, name)
    const destination = join(options.rootDirectory, 'active', name)
    result.plan.push(`${source} -> ${destination}`)
    if (!isBrainDumpSlug(slug)) {
      result.failed.push({ path: source, message: 'Filename must be a lowercase kebab-case slug.' })
      continue
    }
    if ((await pathExists(destination)) || (await pathExists(join(options.rootDirectory, 'archived', name)))) {
      result.skipped.push(slug)
      continue
    }
    try {
      const markdown = convertLegacyLinks(await readFile(source, 'utf8'), knownSlugs)
      parseBrainDumpTopic(markdown, slug, 'active')
      prepared.push({ slug, markdown, destination })
    } catch (error) {
      result.failed.push({ path: source, message: (error as Error).message })
    }
  }
  options.onPlan?.(result.plan)
  if (result.failed.length || result.skipped.length) return result
  await mkdir(join(options.rootDirectory, 'active'), { recursive: true })
  for (const item of prepared) {
    const temporary = `${item.destination}.${process.pid}.tmp`
    try {
      await writeNewFileDurably(temporary, item.markdown)
      await rename(temporary, item.destination)
      result.imported.push(item.slug)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      result.failed.push({ path: item.destination, message: (error as Error).message })
      return result
    }
  }
  result.ok = true
  return result
}
