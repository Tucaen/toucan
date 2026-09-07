// The pure half of scripts/release.mjs: how commit subjects become release notes and how a bump
// becomes a version. Kept import-safe (no side effects) so tests can exercise it.

const SECTIONS = [
  { title: 'Features', types: ['feat'] },
  { title: 'Fixes', types: ['fix'] },
  { title: 'Other changes', types: null }
]

/** Groups conventional-commit subjects into note sections; anything unprefixed lands in "Other". */
export function releaseNotes(previousTag, subjects) {
  const grouped = new Map(SECTIONS.map((section) => [section.title, []]))
  for (const subject of subjects) {
    const match = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/.exec(subject)
    const type = match?.[1] ?? null
    const scope = match?.[2]
    const text = match ? match[3] : subject
    const section = SECTIONS.find((candidate) => candidate.types === null || candidate.types.includes(type))
    grouped.get(section.title).push(scope ? `**${scope}:** ${text}` : text)
  }
  const lines = [previousTag ? `## Changes since ${previousTag}` : '## Changes', '']
  for (const [title, entries] of grouped) {
    if (entries.length === 0) continue
    lines.push(`### ${title}`, ...entries.map((entry) => `- ${entry}`), '')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** `patch`, `minor`, `major`, or an explicit `x.y.z`. Returns the next version without a `v`. */
export function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump
  const [major, minor, patch] = current.split('.').map(Number)
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    default:
      throw new Error(`Unknown bump "${bump}"; use patch, minor, major or x.y.z.`)
  }
}
