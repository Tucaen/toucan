import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * The main window's frame: the native title bar is hidden and the app header takes its place, but
 * Windows still draws the minimize/maximize/close buttons over the header's right edge. Keeping
 * the native buttons rather than drawing our own is what keeps the Snap Layouts flyout on
 * maximize, the system hover states and high-contrast colours. `color` and `symbolColor` are the
 * header's background and `--neutral-100` in `styles.css`, and `height` stops one pixel short of
 * the header so its bottom border runs on under the buttons; `tests/window-chrome.test.ts` holds
 * both sides together.
 */
export const MAIN_WINDOW_CHROME = {
  titleBarStyle: 'hidden',
  titleBarOverlay: {
    color: '#0e1117',
    symbolColor: '#cbd2dc',
    height: 51
  }
} satisfies BrowserWindowConstructorOptions
