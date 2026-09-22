/**
 * The project palette, shared because a colour is both assigned at project creation (renderer) and
 * validated on load (main). `src/shared` stays React/Node free, so this is plain data plus two
 * pure predicates.
 */

/** The six colours a new project cycles through, and the swatches the colour picker offers. */
export const PROJECT_COLOR_PALETTE = ['#71a9ff', '#e69a71', '#74d8a2', '#c992ff', '#f1c75b', '#e8799b'] as const

/**
 * The one stored shape: lowercase `#rrggbb`. A colour reaches CSS custom properties and node data
 * unescaped, so anything that is not exactly this is not a colour Toucan will keep.
 */
export function isProjectColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value)
}

/**
 * Folds a user-supplied colour (a native colour input reports `#RRGGBB`) into the stored shape, or
 * `null` when it is not a six-digit hex colour at all.
 */
export function normalizeProjectColor(value: string): string | null {
  const candidate = value.trim().toLowerCase()
  return isProjectColor(candidate) ? candidate : null
}

/** The palette colour a project at `index` is created with. */
export function paletteColorAt(index: number): string {
  const size = PROJECT_COLOR_PALETTE.length
  // The modulo keeps the read in range for any integer, including a negative one; the fallback is
  // unreachable and exists so the palette's own emptiness could never be a crash.
  return PROJECT_COLOR_PALETTE[((index % size) + size) % size] ?? PROJECT_COLOR_PALETTE[0]
}
