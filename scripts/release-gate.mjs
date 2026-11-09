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
