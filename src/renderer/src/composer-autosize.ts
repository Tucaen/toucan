/**
 * The composer's resting height: one comfortable line plus its padding.
 * @internal exported for tests
 */
export const COMPOSER_MIN_HEIGHT = 46

/**
 * How tall the composer may grow before it starts scrolling instead. Bounded so a long prompt
 * can never swallow the transcript it is being written against.
 * @internal exported for tests
 */
export const COMPOSER_MAX_HEIGHT = 168

export interface ComposerTextareaSize {
  height: number
  /** True once the content no longer fits, so the caller can turn the box's own scrollbar on. */
  scrollable: boolean
}

/**
 * Maps a textarea's natural content height onto the height it should actually be given. Kept
 * separate from the DOM effect that applies it so the growth bounds are directly testable.
 */
export function composerTextareaSize(scrollHeight: number): ComposerTextareaSize {
  return {
    height: Math.min(Math.max(scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT),
    scrollable: scrollHeight > COMPOSER_MAX_HEIGHT
  }
}
