import { useEffect, useRef } from 'react'
import { indentWithTab, defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import { isMarkdownPath } from '../../shared/file-view'

export interface CodeEditorProps {
  /** The text the editor should show. A change here that the editor did not itself make replaces the document. */
  value: string
  /** Decides the language; a Markdown path also wraps long lines, since it is prose. */
  path: string
  readOnly: boolean
  onChange: (text: string) => void
  /** Ctrl+S inside the editor. */
  onSave: () => void
}

/**
 * Which grammar a file gets is decided by `@codemirror/language-data` from the file name, the same
 * list CodeMirror ships for its own demos - so `.mjs`, `.tsx`, `.toml`, and dozens more read well
 * without a table of our own to keep. Grammars load lazily; a file no grammar claims stays plain.
 */
export function languageDescriptionForPath(path: string): LanguageDescription | null {
  const name = path.replace(/\\/g, '/').split('/').at(-1) ?? path
  return LanguageDescription.matchFilename(languages, name)
}

/**
 * The file node's raw view and editor in one CodeMirror 6 instance, created once per mounted node.
 * Highlighting uses `classHighlighter`, whose stable `tok-*` classes are themed in `styles.css`
 * beside the transcript's highlight.js palette rather than through CodeMirror's generated ones.
 * Callbacks are read through refs so a re-render never has to rebuild the view.
 */
export default function CodeEditor({ value, path, readOnly, onChange, onSave }: CodeEditorProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const language = useRef(new Compartment())
  const editable = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  const initialValue = useRef(value)
  const initialReadOnly = useRef(readOnly)

  useEffect(() => {
    if (!host.current) return
    const extensions: Extension[] = [
      lineNumbers(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      bracketMatching(),
      syntaxHighlighting(classHighlighter),
      keymap.of([
        { key: 'Mod-s', run: () => (onSaveRef.current(), true) },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab
      ]),
      language.current.of([]),
      editable.current.of(readOnlyExtension(initialReadOnly.current)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      })
    ]
    if (isMarkdownPath(path)) extensions.push(EditorView.lineWrapping)
    const editor = new EditorView({
      state: EditorState.create({ doc: initialValue.current, extensions }),
      parent: host.current
    })
    view.current = editor
    let active = true
    const description = languageDescriptionForPath(path)
    if (description) {
      void description
        .load()
        .then((support) => {
          if (active) editor.dispatch({ effects: language.current.reconfigure(support) })
        })
        .catch(() => {
          // A grammar that fails to load leaves the file plain; that is still a readable file.
        })
    }
    return () => {
      active = false
      editor.destroy()
      view.current = null
    }
  }, [path])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(readOnlyExtension(readOnly)) })
  }, [readOnly])

  return <div className="code-editor" ref={host} />
}

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}
