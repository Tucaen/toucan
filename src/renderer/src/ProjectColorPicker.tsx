import { useEffect, useRef, useState } from 'react'
import { PROJECT_COLOR_PALETTE, normalizeProjectColor } from '../../shared/project-colors'

/**
 * The six palette swatches plus an escape hatch. A project's colour is denormalised onto every
 * node it owns, so the one thing this control guarantees is the stored shape: a swatch is already
 * a lowercase `#rrggbb`, and the native colour input's `#RRGGBB` is folded into one before it
 * reaches the workspace.
 */

export interface ProjectColorPickerProps {
  color: string
  onPick(color: string): void
}

export default function ProjectColorPicker(props: ProjectColorPickerProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  // The native picker streams a colour per pointer move as `input` events, which React reports as
  // `onChange`; every one of those would fan a colour across the canvas and re-serialise the whole
  // workspace. So the input echoes locally and only the native `change` - the colour the user
  // settled on - is committed.
  const [draft, setDraft] = useState(props.color)
  useEffect(() => setDraft(props.color), [props.color])

  const { onPick } = props
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const commit = (): void => {
      const picked = normalizeProjectColor(input.value)
      if (picked) onPick(picked)
    }
    input.addEventListener('change', commit)
    return () => input.removeEventListener('change', commit)
  }, [onPick])

  return (
    <div className="project-color-picker" role="group" aria-label="Project colour">
      <div className="project-color-swatches">
        {PROJECT_COLOR_PALETTE.map((swatch) => {
          const current = swatch === props.color
          return (
            <button
              key={swatch}
              type="button"
              className="project-color-swatch"
              style={{ background: swatch }}
              aria-label={`Colour ${swatch}`}
              aria-pressed={current}
              data-current={current ? 'true' : undefined}
              onClick={() => props.onPick(swatch)}
            />
          )
        })}
      </div>
      <label className="project-color-custom">
        <span>Custom</span>
        <input
          ref={inputRef}
          type="color"
          value={draft}
          aria-label="Custom project colour"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
    </div>
  )
}
