export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

// A message boundary or scrollbar rounding can leave scrollTop a few pixels short of the
// true bottom even when the user is deliberately at the end of the conversation - the
// threshold absorbs that slack without also treating "scrolled up to read" as "at bottom".
export const STICK_TO_BOTTOM_THRESHOLD_PX = 48

/** Whether the scroll position is close enough to the bottom that arriving content should auto-follow. */
export function isNearScrollBottom(metrics: ScrollMetrics, threshold = STICK_TO_BOTTOM_THRESHOLD_PX): boolean {
  const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
  return distanceFromBottom <= threshold
}
