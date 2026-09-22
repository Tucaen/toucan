import { useEffect, useRef, useState } from 'react'
import type { WorkspaceProject } from '../../shared/workspace'

/**
 * The data URL of every project's custom avatar, read once per (project, version): the version on
 * `WorkspaceProject.avatarVersion` changes on every replacement, so a bumped version is what
 * triggers a re-read and an unchanged one costs nothing. A project without a version - or whose
 * stored file cannot be read - simply has no entry, and the chip falls back to its letter.
 */
export function useProjectAvatars(projects: readonly WorkspaceProject[]): Readonly<Record<string, string>> {
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  /** Which version each project's entry was fetched for, so one read never repeats. */
  const fetched = useRef(new Map<string, number>())

  useEffect(() => {
    // Optional access: dom tests install window APIs piecemeal, and a missing avatar api must
    // degrade to letter chips rather than crash the sidebar.
    const api = window.projectAvatarApi
    if (!api) return
    const withAvatar = new Set<string>()
    for (const project of projects) {
      if (project.avatarVersion === undefined) continue
      withAvatar.add(project.id)
      if (fetched.current.get(project.id) === project.avatarVersion) continue
      const version = project.avatarVersion
      fetched.current.set(project.id, version)
      void api.read(project.id).then((url) => {
        // A rapid replacement can settle its reads out of order; only the read issued for the
        // version still on record may write, so a stale data URL can never win.
        if (fetched.current.get(project.id) !== version) return
        setAvatars((current) => {
          if (url) return { ...current, [project.id]: url }
          if (!(project.id in current)) return current
          const { [project.id]: _removed, ...rest } = current
          return rest
        })
      })
    }
    // A removed avatar (or removed project) drops its entry, so the letter chip returns.
    for (const id of fetched.current.keys()) {
      if (withAvatar.has(id)) continue
      fetched.current.delete(id)
      setAvatars((current) => {
        if (!(id in current)) return current
        const { [id]: _removed, ...rest } = current
        return rest
      })
    }
  }, [projects])

  return avatars
}
