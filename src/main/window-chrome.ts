import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * The main window's frame: the native title bar is hidden and the app header takes its place, but
 * Windows still draws the minimize/maximize/close buttons over the header's right edge. Keeping
 * the native buttons rather than drawing our own is what keeps the Snap Layouts flyout on
 * maximize, the system hover states and high-contrast colours. `color` and `height` have to match
 * `.app-header` in `styles.css`; `tests/window-chrome.test.ts` holds the two together.
 */
export const MAIN_WINDOW_CHROME = {
  titleBarStyle: 'hidden',
  titleBarOverlay: {
    color: '#0e1117',
    symbolColor: '#cbd2dc',
    height: 52
  }
} satisfies BrowserWindowConstructorOptions
