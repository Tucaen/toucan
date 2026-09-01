import type { BrainDumpCollection } from '../../shared/brain-dump'
import { isBrainDumpSlug } from '../../shared/brain-dump'

/**
 * `[[slug]]` is the brain-dump library's own cross-reference syntax; Markdown knows nothing about
 * it. Rather than teach the renderer a second link concept, this module rewrites each reference
 * into an ordinary Markdown link on an Toucan-private scheme, and classifies every href the reader
 * then hands back. Keeping both halves here means the reader never has to guess whether an href
 * is a topic, a browser URL, a local file, or something that must not navigate at all.
 */

/** The private scheme carrying a `[[slug]]` reference through the Markdown pipeline. */
export const BRAIN_DUMP_TOPIC_SCHEME = 'toucan-topic:'

export type BrainDumpLinkKind =
  | { kind: 'topic'; slug: string }
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'unsupported' }

export interface BrainDumpTopicIndex {
  active: ReadonlySet<string>
  archived: ReadonlySet<string>
}

export type BrainDumpLinkResolution =
  { status: 'found'; slug: string; collection: BrainDumpCollection } | { status: 'missing'; slug: string }

const REFERENCE = /\[\[([^\]\n]+)\]\]/g

/**
 * Splits `markdown` into runs that must be left exactly as written (fenced blocks and inline code)
 * and runs that may be rewritten. A reference inside a code span is documentation *about* the
 * syntax, not a link.
 */
function codeSafeSegments(markdown: string): { text: string; code: boolean }[] {
  const segments: { text: string; code: boolean }[] = []
  const pattern = /(^|\n)(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\s*\3[^\n]*(?=\n|$)|$)|(`+)[\s\S]*?\4/g
  let index = 0
  for (let match = pattern.exec(markdown); match; match = pattern.exec(markdown)) {
    if (match.index > index) segments.push({ text: markdown.slice(index, match.index), code: false })
    segments.push({ text: match[0], code: true })
    index = match.index + match[0].length
  }
  if (index < markdown.length) segments.push({ text: markdown.slice(index), code: false })
  return segments
}

/** Every well-formed `[[slug]]` reference in `markdown`, in first-appearance order, deduplicated. */
export function parseBrainDumpReferences(markdown: string): string[] {
  const slugs: string[] = []
  const seen = new Set<string>()
  for (const segment of codeSafeSegments(markdown)) {
    if (segment.code) continue
    for (const match of segment.text.matchAll(REFERENCE)) {
      const slug = match[1].trim()
      if (!isBrainDumpSlug(slug) || seen.has(slug)) continue
      seen.add(slug)
      slugs.push(slug)
    }
  }
  return slugs
}

/**
 * Rewrites `[[slug]]` into a Markdown link the reader can render. A malformed reference is left
 * as literal text: inventing a link for it would promise navigation that can never work.
 */
export function linkifyBrainDumpReferences(markdown: string): string {
  return codeSafeSegments(markdown)
    .map((segment) =>
      segment.code
        ? segment.text
        : segment.text.replace(REFERENCE, (literal, raw: string) => {
            const slug = raw.trim()
            return isBrainDumpSlug(slug) ? `[${slug}](${BRAIN_DUMP_TOPIC_SCHEME}${slug})` : literal
          })
    )
    .join('')
}

/**
 * What an href in a rendered topic actually is. Only `http`/`https` may reach the external
 * handler; an absolute `file:` URL is a local path for an explicit reveal action, and everything
 * else - including relative links and `javascript:` - is inert.
 */
export function classifyBrainDumpLink(href: string | undefined): BrainDumpLinkKind {
  if (!href) return { kind: 'unsupported' }
  if (href.startsWith(BRAIN_DUMP_TOPIC_SCHEME)) {
    const slug = href.slice(BRAIN_DUMP_TOPIC_SCHEME.length)
    return isBrainDumpSlug(slug) ? { kind: 'topic', slug } : { kind: 'unsupported' }
  }
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { kind: 'unsupported' }
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'external', url: url.toString() }
  if (url.protocol !== 'file:') return { kind: 'unsupported' }
  const path = decodeURIComponent(url.pathname)
  // file:///D:/notes.md yields "/D:/notes.md"; the drive letter is the real start of the path.
  const local = /^\/[A-Za-z]:/.test(path) ? path.slice(1).replace(/\//g, '\\') : path
  return local ? { kind: 'file', path: local } : { kind: 'unsupported' }
}

/** Where a `[[slug]]` reference points, given the slugs each collection currently holds. */
export function resolveBrainDumpReference(slug: string, index: BrainDumpTopicIndex): BrainDumpLinkResolution {
  if (index.active.has(slug)) return { status: 'found', slug, collection: 'active' }
  if (index.archived.has(slug)) return { status: 'found', slug, collection: 'archived' }
  return { status: 'missing', slug }
}
