// What `npm run release` checks before it tags. The release workflow runs the same `npm run check`
// as CI, so tagging a commit whose CI is red only reruns that failure and leaves a tag with no
// release behind it - which is how v0.26.0, v0.26.4 and v0.26.8 failed. v0.26.3 was tagged while
// CI was still running (the bump's push then cancelled it), and a commit pushed in a batch has no
// run of its own, so only a completed, successful run counts. Pure, so the rules are testable
// without git or GitHub; scripts/release.mjs feeds them.

/**
 * Why `sha` must not be released, or null when its CI run succeeded. `runs` is `gh run list
 * --workflow ci.yml --commit <sha>` output, newest first, so a successful re-run outranks the
 * attempt it replaced.
 */
export function ciRefusal(sha, runs) {
  const latest = runs[0]
  if (!latest) return `no CI run found for ${sha}; push it and wait for CI before releasing.`
  if (latest.status !== 'completed') return `CI for ${sha} is still running (${latest.url}); wait for it to pass.`
  if (latest.conclusion !== 'success') {
    return `CI for ${sha} ended in ${latest.conclusion} (${latest.url}); the release would fail the same way.`
  }
  return null
}

/** Commit subjects that are changes: not blank, and not the bare-version bump commit of a release. */
export function changeSubjects(subjects) {
  return subjects.filter((subject) => subject.length > 0 && !/^\d+\.\d+\.\d+$/.test(subject))
}

/**
 * The tag the release notes count from: the newest tag reachable from HEAD that has a published
 * release, so the changes of a tag whose release failed reach the next notes instead of vanishing.
 * `mergedTags` is newest first; with no published one among them it falls back to the newest tag.
 */
export function previousReleaseTag(mergedTags, publishedTags) {
  const published = new Set(publishedTags)
  return mergedTags.find((tag) => published.has(tag)) ?? mergedTags[0] ?? null
}

// What the release workflow checks before it builds anything (scripts/release-ci-gate.mjs feeds
// these). `npm run release` checks CI on HEAD, but a tag pushed by hand never runs it, so the
// workflow repeats the check on the tagged commit itself.

const VERSION_FILES = new Set(['package.json', 'package-lock.json'])

function withoutVersion(json) {
  if (!json || typeof json !== 'object') return json
  const copy = structuredClone(json)
  delete copy.version
  if (copy.packages?.['']) delete copy.packages[''].version
  return copy
}

/**
 * Whether a commit is the bump `npm run release` makes: its subject is the bare version and it
 * changes nothing but the version fields `npm version` writes. CI on such a commit adds nothing
 * to CI on its parent - the tree `npm run release` already required to be green - so the
 * workflow gates on the parent instead of waiting for a run on the bump. `files` maps every path
 * the commit touches to its parsed JSON before and after (anything not a version file is enough
 * to say no).
 */
export function isVersionBump(subject, files) {
  if (!/^\d+\.\d+\.\d+$/.test(subject)) return false
  const paths = Object.keys(files)
  if (paths.length === 0 || !paths.every((path) => VERSION_FILES.has(path))) return false
  return paths.every((path) => {
    const [before, after] = files[path]
    return JSON.stringify(withoutVersion(before)) === JSON.stringify(withoutVersion(after))
  })
}

/**
 * Why `tag` must not be built, or null. electron-builder publishes into `v<package.json version>`
 * while the workflow claims the release named by the tag, so a mismatch fills a different release
 * than the one the notes went into.
 */
export function tagRefusal(tag, version) {
  if (tag === `v${version}`) return null
  return `tag ${tag} does not match package.json version ${version}; the installers would publish to v${version}.`
}

/**
 * Whether to keep waiting for `sha`'s CI, or the verdict. A run still going is waited for up to
 * `limits.runningMs`; a commit with no run yet up to `limits.missingMs`, because GitHub registers
 * the run of a just-pushed commit a little after the tag arrives - but a commit pushed in a batch
 * never gets one of its own.
 */
export function ciDecision(sha, runs, waitedMs, limits) {
  const latest = runs[0]
  if (!latest && waitedMs < limits.missingMs) return { wait: true }
  if (latest && latest.status !== 'completed' && waitedMs < limits.runningMs) return { wait: true }
  return { wait: false, refusal: ciRefusal(sha, runs) }
}
