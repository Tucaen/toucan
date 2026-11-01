import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { classifyMarkdownLink } from '../../src/shared/local-file-link'
import { remarkHardBreaks } from '../../src/shared/markdown-hard-breaks'
import { remoteImagePath } from '../../src/shared/remote-file'
import type { HostEndpoint } from './hosts'
import { fetchLocalImage } from './remote-client'

/**
 * Chat prose on the phone, with links that do what they say.
 *
 * Every destination is kept past react-markdown's sanitizer and classified here instead, with the
 * same classifier the desktop uses, because the sanitizer would turn `D:\x.png` into an empty
 * `href` that reloads the chat when tapped. Only a web URL ever becomes a real `href`, and it opens
 * in a new tab so the app is not navigated away. A local image becomes a button that asks the host
 * for the file and shows it full-screen. Every other destination - a relative path, another local
 * file, a private scheme - is rendered as inert text, which is exactly what makes keeping them safe.
 */
export default function ChatMarkdown({
  host,
  text,
  authored = false
}: {
  host: HostEndpoint
  text: string
  /** Typed by a person, so single line breaks are kept; see `markdown-hard-breaks.ts`. */
  authored?: boolean
}): JSX.Element {
  const [viewing, setViewing] = useState<{ path: string; label: string } | null>(null)

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const image = remoteImagePath(href)
        if (image) {
          return (
            <ImageLinkButton onOpen={() => setViewing({ path: image, label: fileName(image) })}>
              {children}
            </ImageLinkButton>
          )
        }
        const target = classifyMarkdownLink(href)
        if (target.kind === 'external') {
          return (
            <a href={target.url} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          )
        }
        return (
          <span
            className="inert-link"
            title={target.kind === 'file' ? 'Only images can be opened on the phone.' : undefined}
          >
            {children}
          </span>
        )
      },
      img: ({ src, alt }) => {
        const image = typeof src === 'string' ? remoteImagePath(src) : null
        const label = alt || (image ? fileName(image) : 'Image')
        if (image) {
          return <ImageLinkButton onOpen={() => setViewing({ path: image, label })}>{label}</ImageLinkButton>
        }
        // A web image is not loaded inline - the page's policy would refuse another origin anyway -
        // but it stays reachable as a link.
        const target = typeof src === 'string' ? classifyMarkdownLink(src) : { kind: 'unsupported' as const }
        return target.kind === 'external' ? (
          <a href={target.url} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          <span className="inert-link">{label}</span>
        )
      }
    }),
    []
  )

  return (
    <>
      <Markdown
        remarkPlugins={authored ? [remarkGfm, remarkHardBreaks] : [remarkGfm]}
        components={components}
        urlTransform={keepUrl}
      >
        {text}
      </Markdown>
      {viewing && (
        <LocalImageViewer host={host} path={viewing.path} label={viewing.label} onClose={() => setViewing(null)} />
      )}
    </>
  )
}

/** Safe only because `components` decides what each kept destination may become. */
const keepUrl = (url: string): string => url

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function ImageLinkButton({ onOpen, children }: { onOpen(): void; children: ReactNode }): JSX.Element {
  return (
    <button type="button" className="image-link" onClick={onOpen}>
      <span aria-hidden="true">🖼 </span>
      {children}
    </button>
  )
}

type ViewerState = { phase: 'loading' } | { phase: 'shown'; url: string } | { phase: 'failed'; message: string }

/**
 * One image, fetched from the host when the reader asked for it and never before: a transcript may
 * link dozens, and a phone on mobile data should pay only for the ones opened. The object URL lives
 * exactly as long as the viewer, and closing mid-fetch aborts the request.
 */
function LocalImageViewer({
  host,
  path,
  label,
  onClose
}: {
  host: HostEndpoint
  path: string
  label: string
  onClose(): void
}): JSX.Element {
  const [state, setState] = useState<ViewerState>({ phase: 'loading' })
  const { origin, token } = host

  // Keyed on the endpoint's values, not its identity, so a re-render of the chat never re-fetches.
  useEffect(() => {
    const controller = new AbortController()
    let url: string | null = null
    void fetchLocalImage({ origin, token }, path, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!result.ok) {
        setState({
          phase: 'failed',
          message: result.kind === 'unauthorized' ? 'This host no longer accepts this device.' : result.message
        })
        return
      }
      url = URL.createObjectURL(result.value)
      setState({ phase: 'shown', url })
    })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [origin, token, path])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <div className="image-viewer-bar" onClick={(event) => event.stopPropagation()}>
        <span className="image-viewer-title">{label}</span>
        {state.phase === 'shown' && (
          <a className="image-viewer-action" href={state.url} download={fileName(path)}>
            Save
          </a>
        )}
        <button type="button" className="image-viewer-action" onClick={onClose} aria-label="Close image">
          ✕
        </button>
      </div>
      {state.phase === 'loading' && (
        <p className="image-viewer-note" role="status">
          Loading from the desktop…
        </p>
      )}
      {state.phase === 'failed' && (
        <p className="image-viewer-note" role="alert">
          {state.message}
        </p>
      )}
      {state.phase === 'shown' && (
        <img className="image-viewer-image" src={state.url} alt={label} onClick={(event) => event.stopPropagation()} />
      )}
    </div>
  )
}
