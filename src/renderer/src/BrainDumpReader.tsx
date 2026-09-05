import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import type { BrainDumpTopic } from '../../shared/brain-dump'
import type { WorkspaceProject } from '../../shared/terminal'
import { classifyBrainDumpLink, linkifyBrainDumpReferences, parseBrainDumpReferences } from './brain-dump-links'
import { describeBrainDumpDate, resolveBrainDumpProject } from './brain-dump-topics'
import { BrainDumpProjectChip } from './BrainDumpProjectChip'
import BrainDumpProjectPicker from './BrainDumpProjectPicker'
import { markdownBlockComponents, remarkPlugins } from './MarkdownMessage'

/**
 * The reader column. Topic prose is ordinary Markdown, so it reuses the transcript's GFM pipeline
 * and memoized code blocks; only links differ, because a topic can point at another topic, at the
 * browser, or at a file on disk, and each of those needs a different - and differently safe -
 * action. Every reference in the open topic is resolved against the library up front, so a link to
 * something that was never written reads as missing instead of failing on click.
 */

/**
 * react-markdown's default URL sanitizer drops `file:` and any private scheme, which would erase
 * exactly the two link kinds this reader exists to handle. Safety is enforced afterwards instead:
 * `classifyBrainDumpLink` decides what an href is, and anything it does not recognize is rendered
 * as inert text with no `href` at all, so nothing unclassified ever becomes clickable.
 */
const keepHref = (url: string): string => url

export interface BrainDumpReaderProps {
  topic: BrainDumpTopic
  projects: readonly WorkspaceProject[]
  today: string
  lifecyclePending: boolean
  /** In flight state of a project reassignment, kept separate from the archive's own. */
  assignmentPending: boolean
  assignmentError?: string
  /** Rendered only in narrow mode, where the reader replaces the list. */
  onBack?(): void
  onArchive(): void
  onAssignProject(project: WorkspaceProject | undefined): void
  onOpenProjectPicker(): void
  /** Set when something outside the reader - a chip in the list - asked for the picker. */
  projectPickerSignal?: number
  onOpenReference(slug: string): void
  resolveReference(slug: string): Promise<boolean>
  readerRef?: React.RefObject<HTMLDivElement>
}

export default function BrainDumpReader(props: BrainDumpReaderProps): JSX.Element {
  const { topic } = props
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set())
  const fallbackRef = useRef<HTMLDivElement>(null)
  const scroller = props.readerRef ?? fallbackRef
  const project = resolveBrainDumpProject(topic.projectPath, props.projects)
  const source = useMemo(() => linkifyBrainDumpReferences(topic.markdown), [topic.markdown])

  const { resolveReference } = props
  useEffect(() => {
    let active = true
    const references = parseBrainDumpReferences(topic.markdown)
    if (references.length === 0) {
      setMissing(new Set())
      return
    }
    void Promise.all(references.map(async (slug) => [slug, await resolveReference(slug)] as const)).then((results) => {
      if (active) setMissing(new Set(results.filter(([, found]) => !found).map(([slug]) => slug)))
    })
    return () => {
      active = false
    }
  }, [resolveReference, topic.markdown])

  /*
   * The anchor component must keep the same identity for the life of the reader. Rebuilding it when
   * a reference resolves would make React unmount every rendered link and mount a replacement, and
   * a link the user clicked in that instant would be a detached node with no handler - which in
   * Electron means the app window navigates away. Live values therefore arrive through refs.
   */
  const missingRef = useRef(missing)
  missingRef.current = missing
  const openReferenceRef = useRef(props.onOpenReference)
  openReferenceRef.current = props.onOpenReference

  const components = useMemo<Components>(
    () => ({
      ...markdownBlockComponents,
      a(anchorProps) {
        const href = typeof anchorProps.href === 'string' ? anchorProps.href : undefined
        const link = classifyBrainDumpLink(href)
        if (link.kind === 'topic' && missingRef.current.has(link.slug)) {
          return (
            <span className="brain-dump-missing-link" role="note">
              {anchorProps.children}
              <span className="visually-hidden"> — Missing topic. It has not been written yet.</span>
              <span aria-hidden="true" className="brain-dump-missing-badge">
                Missing topic
              </span>
            </span>
          )
        }
        if (link.kind === 'unsupported') {
          return <span className="brain-dump-inert-link">{anchorProps.children}</span>
        }
        const title =
          link.kind === 'topic'
            ? `Open the ${link.slug} topic`
            : link.kind === 'file'
              ? `Reveal ${link.path} in Explorer`
              : `Open ${link.url} in your browser`
        return (
          <a
            href={href}
            title={title}
            data-link-kind={link.kind}
            onClick={(event) => {
              event.preventDefault()
              if (link.kind === 'topic') openReferenceRef.current(link.slug)
              // A file: URL must never reach the web handler or navigate the Electron window; the
              // only safe local action is selecting the file in the OS file manager.
              else if (link.kind === 'file') void window.terminalApi?.showItemInFolder?.(link.path)
              else void window.terminalApi?.openExternal?.(link.url)
            }}
          >
            {anchorProps.children}
          </a>
        )
      }
    }),
    []
  )

  return (
    <section className="brain-dump-reader" aria-label={`Topic ${topic.title}`}>
      <div className="brain-dump-reader-toolbar">
        {props.onBack && (
          <button type="button" className="brain-dump-back" onClick={props.onBack}>
            <ArrowLeft aria-hidden="true" />
            Back to list
          </button>
        )}
        <div className="brain-dump-reader-identity">
          <h3>{topic.title}</h3>
          <span className="brain-dump-reader-slug" title="Reference this topic with this identity">
            [[{topic.slug}]]
          </span>
          {/* An archived topic is an immutable snapshot, so its project is reported, not offered. */}
          {topic.collection === 'active' ? (
            <BrainDumpProjectPicker
              project={project}
              projects={props.projects}
              pending={props.assignmentPending}
              error={props.assignmentError}
              onAssign={props.onAssignProject}
              onOpen={props.onOpenProjectPicker}
              openSignal={props.projectPickerSignal}
            />
          ) : (
            <BrainDumpProjectChip project={project} />
          )}
          <span className="brain-dump-reader-date">Updated {describeBrainDumpDate(topic.updated, props.today)}</span>
        </div>
        <div className="brain-dump-reader-actions">
          {topic.collection === 'active' && (
            <button type="button" onClick={props.onArchive} disabled={props.lifecyclePending}>
              Archive
            </button>
          )}
        </div>
      </div>
      <div ref={scroller} className="brain-dump-reader-body" tabIndex={0}>
        <div className="markdown-body brain-dump-prose">
          <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={keepHref}>
            {source}
          </ReactMarkdown>
        </div>
      </div>
    </section>
  )
}
