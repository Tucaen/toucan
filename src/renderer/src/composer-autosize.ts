/** The composer's resting height: one comfortable line plus its padding. */
export const COMPOSER_MIN_HEIGHT = 46

/**
 * How tall the composer may grow before it starts scrolling instead. Bounded so a long prompt
 * can never swallow the transcript it is being written against.
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

/** The parts of a scrolled textarea that decide whether it can absorb a wheel gesture. */
export interface ComposerScrollState {
  scrollHeight: number
  clientHeight: number
}

/**
 * True when the composer itself can move under a wheel gesture, in which case the canvas must not
 * also see it. A grown composer swallowing the wheel is what stops the canvas zooming out from
 * under someone re-reading their own prompt, and it keeps claiming the gesture at both ends of its
 * travel - releasing it there would zoom the canvas mid-scroll. A composer with nothing to scroll
 * has no gesture to claim, so a wheel over a short draft still zooms as usual. Fractional layout
 * heights leave the overflow just shy of zero on a box that only just fits, hence the 1px slack.
 */
export function composerConsumesWheel(state: ComposerScrollState): boolean {
  return state.scrollHeight - state.clientHeight > 1
}
